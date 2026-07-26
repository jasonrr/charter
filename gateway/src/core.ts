/**
 * Translation to charter-core.
 *
 * This is charter_mcp.js's callBridge(), minus the local-file tricks and minus
 * Node. One POST of {...args, verb} to core's single endpoint, through the
 * CF-Access tunnel, carrying — when a human is signed in — their Google ID
 * token as X-Actor-Token and nothing else that claims authority. Core verifies
 * that token itself and derives the caller's scope from grants; the gateway
 * decides nothing (spec §2.1).
 *
 * fetch is a parameter, not a global, so every branch here is unit-testable
 * without a Worker runtime or a network.
 */
import { redact } from "./redact.js";

/** 1 MB, matching the stdio proxy's cap on what may enter a model's context. */
const MAX_RESPONSE_BYTES = 1 << 20;

const TRUNCATE_SUFFIX = "\n...[truncated]";
// Suffix is ASCII, so its char length equals its byte length.
const TRUNCATE_SUFFIX_BYTES = TRUNCATE_SUFFIX.length;
// Cutting a raw byte slice mid-character can turn a 1-3 byte UTF-8 sequence
// into a single 3-byte U+FFFD replacement char on decode — up to 2 bytes
// bigger than what it replaced. Reserve that much extra so the final,
// re-encoded result can never land over the cap even in that worst case.
const UTF8_REPLACEMENT_SLACK = 2;
const TRUNCATE_BUDGET_BYTES =
  MAX_RESPONSE_BYTES - TRUNCATE_SUFFIX_BYTES - UTF8_REPLACEMENT_SLACK;

export type CoreConfig = {
  url: string;
  /** CF Access service token — the network gate on core's tunnel. */
  cfAccessClientId: string;
  cfAccessClientSecret: string;
  /**
   * Optional, and deliberately unset in the human-facing deployment. See
   * authHeaders(): it is sent only on a call with no signed-in human behind it.
   */
  apiKey?: string;
  userAgent?: string;
};

export type CoreResult = { text: string; isError: boolean };

type CappedBody = { text: string; truncated: boolean };

/**
 * The credential headers for one call to core.
 *
 * Two headers always go: the CF Access service token. It is the *network* gate
 * on core's tunnel — it says the caller is the gateway, not what the caller may
 * do — so it is orthogonal to who is signed in.
 *
 * X-API-Key goes ONLY when there is no actor token, and that is the whole
 * point of this function. Core's `bridge()` resolves `identify()` (the key)
 * before `identify_by_actor()` (the verified human + grants), so a key sent
 * alongside a human's token replaces that human's grant with the gateway's own
 * allow-list — every signed-in caller would run with the union of what everyone
 * needs, and `charter-grants` would be dead config. Invariant §2.1 says the
 * gateway holds no authority of its own: it presents identity, core decides
 * scope. Sending both breaks that silently, so the two are made exclusive here
 * rather than left to whoever writes the config.
 */
export function authHeaders(
  cfg: CoreConfig,
  actorToken?: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (cfg.cfAccessClientId) headers["CF-Access-Client-Id"] = cfg.cfAccessClientId;
  if (cfg.cfAccessClientSecret)
    headers["CF-Access-Client-Secret"] = cfg.cfAccessClientSecret;
  if (actorToken) headers["X-Actor-Token"] = actorToken;
  else if (cfg.apiKey) headers["X-API-Key"] = cfg.apiKey;
  return headers;
}

/** This config's credentials, as the list `redact()` wants. */
function coreSecrets(cfg: CoreConfig): (string | undefined)[] {
  return [cfg.cfAccessClientId, cfg.cfAccessClientSecret, cfg.apiKey];
}

/**
 * Read a response body capped at MAX_RESPONSE_BYTES, streaming — the Workers
 * port of the stdio proxy's readCapped() (plugin/proxy/charter_mcp.js:353).
 * Buffering the full body first (as `res.text()` would) defeats the point of
 * a cap: a Worker isolate is more memory-constrained than the Node process
 * the original ran in, and isolates can be shared across concurrent
 * requests, so one oversized upstream response can hurt more than itself.
 * Reading the stream also means the cap is counted in actual bytes, not
 * UTF-16 code units — a body full of multi-byte characters no longer runs
 * well past the cap before truncating.
 */
async function readCapped(res: Response): Promise<CappedBody> {
  const body = res.body;
  if (!body) return { text: await res.text(), truncated: false }; // e.g. an empty body under some runtimes

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;
    if (total >= MAX_RESPONSE_BYTES) {
      truncated = true;
      break;
    }
    if (total + value.length > MAX_RESPONSE_BYTES) {
      chunks.push(value.subarray(0, MAX_RESPONSE_BYTES - total));
      total = MAX_RESPONSE_BYTES;
      truncated = true;
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  // Stop draining bytes we're about to discard rather than let the
  // connection sit reading the rest of an oversized body.
  if (truncated) await reader.cancel().catch(() => {});

  let combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  if (truncated) combined = combined.subarray(0, TRUNCATE_BUDGET_BYTES);

  // Default (non-fatal) decode: a slice can land mid-character on the way
  // in; this tolerates that with a replacement char instead of throwing.
  let text = new TextDecoder("utf-8").decode(combined);
  if (truncated) text += TRUNCATE_SUFFIX;
  return { text, truncated };
}

export async function callCore(
  fetchImpl: typeof fetch,
  cfg: CoreConfig,
  verb: string,
  args: object,
  opts: { readOnly?: boolean; actorToken?: string },
): Promise<CoreResult> {
  if (!verb) return { text: "missing 'verb'", isError: true };

  let u: URL;
  try {
    u = new URL(cfg.url);
  } catch (e) {
    return { text: `bad core url: ${(e as Error).message}`, isError: true };
  }
  if (u.protocol !== "https:") {
    return {
      text: "refusing to send credentials in cleartext; core url must be https://",
      isError: true,
    };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Explicit UA: Cloudflare 1010-bans default client signatures at the edge,
    // before CF Access runs. Any non-default UA passes.
    "User-Agent": cfg.userAgent ?? "charter-gateway/0.1",
    ...authHeaders(cfg, opts.actorToken),
  };

  const payload = JSON.stringify({
    ...args,
    verb,
    ...(opts.readOnly ? { read_only: true } : {}),
  });

  let res: Response;
  try {
    // Send cfg.url verbatim, not u.toString() — URL re-serializes a bare
    // origin with a trailing slash, which core's contract doesn't expect.
    res = await fetchImpl(cfg.url, {
      method: "POST",
      headers,
      body: payload,
    });
  } catch (e) {
    return {
      text: redact(`request failed: ${(e as Error).message}`, coreSecrets(cfg)),
      isError: true,
    };
  }

  const { text, truncated } = await readCapped(res);
  if (res.status >= 200 && res.status < 300) {
    // ponytail: `isError: truncated` is an interim fix, not resource-link-out
    // (docs/remote-mcp.md §4.5). Truncated JSON is unparseable, and a 2xx
    // telling the model it succeeded anyway is the failure mode that section
    // argues against — so a truncated body is reported as an error even
    // though the HTTP call itself succeeded.
    return { text: redact(text, coreSecrets(cfg)), isError: truncated };
  }
  return {
    text: redact(`HTTP ${res.status}: ${text}`, coreSecrets(cfg)),
    isError: true,
  };
}
