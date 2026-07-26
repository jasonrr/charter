/**
 * Google federation for the gateway.
 *
 * The gateway is its own OAuth authorization server for MCP clients, and a
 * *client* of Google for identity. This module owns only the Google half.
 *
 * Two things make it more than a code exchange (spec §4.6):
 *
 *  1. Audience. Core verifies the ID token against ITS configured Google client
 *     id, so the token must be minted for the gateway's Web client and core must
 *     be pointed at that same client id.
 *  2. Freshness. Google ID tokens live about an hour; an MCP session outlives
 *     that. So we ask for offline access, keep the refresh token in the OAuth
 *     props @cloudflare/workers-oauth-provider already encrypts, and re-mint on demand.
 *
 * decodeIdTokenClaims does NOT verify anything — it reads `exp` and `email` for
 * scheduling and display. Core performs the verification that authorizes
 * anything at all (§2.1).
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Re-mint this many seconds before expiry so a call never races the clock. */
const REFRESH_MARGIN_SECONDS = 60;

/** Cap how much of an upstream error body we echo back so a hostile or oversized response can't be rendered wholesale. */
const MAX_UPSTREAM_ERROR_CHARS = 500;

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** e.g. "@example.com" — matched as a suffix, same rule as core's actor_auth. */
  allowedDomain: string;
};

export type GoogleIdentity = {
  email: string;
  idToken: string;
  idTokenExp: number;
  refreshToken: string;
};

type Claims = {
  email?: string;
  email_verified?: boolean;
  exp?: number;
  aud?: string;
};

/** The bare domain regardless of whether the config was written with a leading "@". */
function bareDomain(cfg: GoogleConfig): string {
  return cfg.allowedDomain.replace(/^@/, "");
}

export function decodeIdTokenClaims(idToken: string): Claims {
  try {
    const seg = idToken.split(".")[1];
    if (!seg) return {};
    const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const parsed = JSON.parse(atob(pad));
    // A payload of `null` (or any non-object) parses without throwing, so guard
    // explicitly rather than letting a raw TypeError reach the caller later.
    return parsed && typeof parsed === "object" ? (parsed as Claims) : {};
  } catch {
    return {}; // ponytail: an unreadable token is simply "no claims"; core rejects it anyway
  }
}

export function buildAuthorizeUrl(cfg: GoogleConfig, state: string): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email");
  u.searchParams.set("state", state);
  // offline + consent are what cause a refresh_token to be issued at all.
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("hd", bareDomain(cfg));
  return u.toString();
}

/** Redact the client secret from anything that might reach a log or a client. */
function safe(message: string, cfg: GoogleConfig): string {
  return cfg.clientSecret
    ? message.split(cfg.clientSecret).join("[redacted]")
    : message;
}

async function tokenRequest(
  fetchImpl: typeof fetch,
  cfg: GoogleConfig,
  form: Record<string, string>,
): Promise<any> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    // Redact BEFORE truncating: cutting the body first can slice a secret in
    // half, leaving a fragment safe() no longer has a full match to remove.
    const redacted = safe(`google token endpoint returned ${res.status}: ${text}`, cfg);
    const capped =
      redacted.length > MAX_UPSTREAM_ERROR_CHARS
        ? `${redacted.slice(0, MAX_UPSTREAM_ERROR_CHARS)}…[truncated]`
        : redacted;
    throw new Error(capped);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("google token endpoint returned a non-JSON response");
  }
}

export async function exchangeCode(
  fetchImpl: typeof fetch,
  cfg: GoogleConfig,
  code: string,
): Promise<GoogleIdentity> {
  const body = await tokenRequest(fetchImpl, cfg, {
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: "authorization_code",
  });

  const idToken: string = body.id_token ?? "";
  const claims = decodeIdTokenClaims(idToken);
  const email = claims.email ?? "";

  if (!claims.email_verified) {
    throw new Error(
      `sign-in rejected: ${email || "that account"} is not a verified account`,
    );
  }
  // "@" makes this an exact domain-boundary match — without it "example.com"
  // would also accept "notexample.com" (Important 1).
  if (!email.endsWith(`@${bareDomain(cfg)}`)) {
    throw new Error(
      `sign-in rejected: charter requires a @${bareDomain(cfg)} account ` +
        `(got ${email || "no email"}); pick your work account`,
    );
  }
  if (!body.refresh_token) {
    // Without this the session dies at the one-hour mark with no way to recover.
    throw new Error(
      "google returned no refresh token; the gateway cannot keep the session " +
        "signed in. Revoke the app at myaccount.google.com and sign in again.",
    );
  }

  return {
    email,
    idToken,
    idTokenExp: claims.exp ?? 0,
    refreshToken: body.refresh_token,
  };
}

export async function freshIdToken(
  fetchImpl: typeof fetch,
  cfg: GoogleConfig,
  identity: GoogleIdentity,
  nowSeconds: number,
): Promise<{ idToken: string; identity: GoogleIdentity }> {
  if (identity.idTokenExp - REFRESH_MARGIN_SECONDS > nowSeconds) {
    return { idToken: identity.idToken, identity };
  }

  let body: any;
  try {
    body = await tokenRequest(fetchImpl, cfg, {
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: identity.refreshToken,
      grant_type: "refresh_token",
    });
  } catch (e) {
    throw new Error(
      "your Google sign-in is no longer valid — sign in again to charter " +
        `(${(e as Error).message})`,
    );
  }

  if (!body.id_token) {
    // No id_token means no fresh token to hand back — surfacing an empty string
    // here would make core treat X-Actor-Token as absent (a bare "unauthorized")
    // instead of this actionable message, so fail the same way invalid_grant does.
    throw new Error(
      "your Google sign-in is no longer valid — sign in again to charter " +
        "(refresh response had no id_token)",
    );
  }

  const idToken: string = body.id_token;
  const claims = decodeIdTokenClaims(idToken);
  return {
    idToken,
    identity: {
      ...identity,
      idToken,
      idTokenExp: claims.exp ?? 0,
      // Google usually omits refresh_token on refresh; adopt it only when rotated.
      refreshToken: body.refresh_token ?? identity.refreshToken,
    },
  };
}
