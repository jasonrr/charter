/**
 * Translation to charter-core.
 *
 * This is charter_mcp.js's callBridge(), minus the local-file tricks and minus
 * Node. One POST of {...args, verb} to core's single endpoint, with the
 * gateway-held credential and — when a human is signed in — their Google ID
 * token as X-Actor-Token. Core verifies that token itself and derives the
 * caller's scope from grants; the gateway decides nothing (spec §2.1).
 *
 * fetch is a parameter, not a global, so every branch here is unit-testable
 * without a Worker runtime or a network.
 */

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
  credential: string;
  userAgent?: string;
};

export type CoreResult = { text: string; isError: boolean };

/**
 * Split the one pasted credential into headers.
 *
 * "cf-client-id:cf-client-secret:api-key" is the composite form; CF ids and
 * secrets are colon-free, so any extra colons belong to the API key. A
 * colon-free value is a bare API key (non-Cloudflare deploys). A two-part value
 * is malformed and yields an empty key, which fails loudly at core with a 401 —
 * deliberately better than silently sending half a credential.
 */
export function credHeaders(credential: string): Record<string, string> {
  const cred = (credential || "").trim();
  const parts = cred.split(":");
  if (parts.length === 1) {
    return {
      "X-API-Key": parts[0],
      "CF-Access-Client-Id": "",
      "CF-Access-Client-Secret": "",
    };
  }
  const [id = "", secret = "", ...key] = parts;
  return {
    "X-API-Key": key.join(":"),
    "CF-Access-Client-Id": id,
    "CF-Access-Client-Secret": secret,
  };
}

/** Strip anything credential-shaped out of text bound for a model or a log. */
function scrub(text: string, cfg: CoreConfig): string {
  let out = text;
  for (const secret of [cfg.credential, ...cfg.credential.split(":")]) {
    if (secret && secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  return out;
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
async function readCapped(res: Response): Promise<string> {
  const body = res.body;
  if (!body) return res.text(); // e.g. an empty body under some runtimes

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
  return text;
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
    ...credHeaders(cfg.credential),
  };
  if (opts.actorToken) headers["X-Actor-Token"] = opts.actorToken;

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
      text: scrub(`request failed: ${(e as Error).message}`, cfg),
      isError: true,
    };
  }

  const text = await readCapped(res);
  if (res.status >= 200 && res.status < 300) {
    return { text, isError: false };
  }
  return { text: scrub(`HTTP ${res.status}: ${text}`, cfg), isError: true };
}
