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

  let text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    const suffix = "\n...[truncated]";
    // Leave room for the suffix so the result is always shorter than the
    // original, even when the overage is smaller than the suffix itself.
    text = text.slice(0, MAX_RESPONSE_BYTES - suffix.length) + suffix;
  }
  if (res.status >= 200 && res.status < 300) {
    return { text, isError: false };
  }
  return { text: scrub(`HTTP ${res.status}: ${text}`, cfg), isError: true };
}
