/**
 * Signed, browser-bound OAuth state.
 *
 * The gateway hands the client's parsed AuthRequest to Google as `state` and
 * reads it back at /callback. Unprotected, that round trip is a login-CSRF:
 * dynamic client registration is open, so anyone can register a client whose
 * redirect_uri they control, call /authorize to mint a state, and phish a
 * victim into completing a *genuine* Google consent. /callback would then bind
 * the victim's identity to the attacker's grant and 302 the code to them.
 *
 * Two things have to be true for a callback to be honoured, and a signature
 * alone gives only the first:
 *
 *  1. The state is one we issued and nobody edited — an HMAC over the whole
 *     payload.
 *  2. It came back in the *same browser* that started the flow — a random
 *     nonce carried both inside the signed payload and in a __Host- cookie,
 *     compared on return. Signing alone is not enough precisely because an
 *     attacker can ask us to sign a state of their own; the cookie is what
 *     they cannot plant in someone else's browser.
 *
 * Both checks are constant-time: the HMAC through WebCrypto's own verify, the
 * nonce through timingSafeEqual below.
 *
 * The payload is length-prefix-free and self-describing, so it is versioned by
 * shape rather than by a version byte: if it ever changes, old states fail the
 * `malformed` check and callers re-authorize, which is the safe direction.
 */

/** How long a sign-in may sit half-finished. Long enough for a slow consent, short enough to bound replay. */
const STATE_TTL_SECONDS = 600;

/** Tolerance for a state minted a moment "ahead" of us — clock skew between isolates, not a real window. */
const CLOCK_SKEW_SECONDS = 60;

/**
 * __Host- forces Secure, Path=/ and no Domain, so the cookie cannot be planted
 * by a sibling subdomain — which is exactly the attacker capability the nonce
 * is defending against.
 *
 * The flow id is part of the *name*, not just the value, so two sign-ins
 * started in one browser get two cookies instead of overwriting each other.
 * With a single fixed name, connecting charter in a second MCP client — or
 * just double-clicking connect — would silently invalidate the first flow.
 */
export const STATE_COOKIE_PREFIX = "__Host-charter_state_";

export function stateCookieName(flowId: string): string {
  return `${STATE_COOKIE_PREFIX}${flowId}`;
}

/** One in-flight sign-in: which cookie it owns, and the secret inside it. */
export type Flow = { flowId: string; nonce: string };

export type OpenResult =
  | {
      ok: true;
      authRequest: unknown;
      /** The flow this state belongs to — enough to re-seal or clear its cookie. */
      flow: Flow;
      consented: boolean;
    }
  | { ok: false; reason: string };

type Payload = {
  /** the client's parsed AuthRequest */
  r: unknown;
  /** nonce, mirrored in the cookie's value */
  n: string;
  /** flow id, mirrored in the cookie's name */
  f: string;
  /** issued-at, epoch seconds */
  t: number;
  /** the user has clicked through the consent screen */
  c?: boolean;
};

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Compare without leaking where two nonces diverge.
 *
 * Length is compared first and non-constant-time, which is fine: our nonces are
 * a fixed length, so a length mismatch already means "not ours".
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function importStateKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** 128 bits of randomness — a value an attacker cannot guess and cannot read out of another browser. */
export function mintNonce(): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * A fresh flow. The id only has to be unique among a browser's concurrent
 * sign-ins, but it costs nothing to make it unguessable too — and a guessable
 * one would let an attacker aim at a specific in-flight cookie.
 */
export function mintFlow(): Flow {
  return { flowId: mintNonce(), nonce: mintNonce() };
}

/**
 * `consented` is inside the signed payload, not a separate cookie or a KV row,
 * so /callback can *require* it rather than infer it. Before this the consent
 * screen was unskippable only by circumstance — the state was disclosed solely
 * in the consent page body and the cookie was HttpOnly — which made the
 * guarantee incidental. A flag the signature covers makes it enforced.
 */
export async function sealState(
  key: CryptoKey,
  authRequest: unknown,
  flow: Flow,
  issuedAt: number,
  consented = false,
): Promise<string> {
  const payload: Payload = {
    r: authRequest,
    n: flow.nonce,
    f: flow.flowId,
    t: issuedAt,
    ...(consented ? { c: true } : {}),
  };
  // Encode to bytes before base64: the client's own `state` rides inside this
  // and may hold characters btoa alone would reject.
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return `${b64urlEncode(body)}.${b64urlEncode(mac)}`;
}

/**
 * Takes the whole Cookie header rather than one cookie value, because which
 * cookie to read is itself derived from the state — and we will not act on the
 * state's contents before the signature has cleared.
 */
export async function openState(
  key: CryptoKey,
  state: string,
  cookieHeader: string | null,
  nowSeconds: number,
): Promise<OpenResult> {
  const dot = state.indexOf(".");
  if (dot <= 0 || dot === state.length - 1) return { ok: false, reason: "malformed state" };

  let body: Uint8Array;
  let mac: Uint8Array;
  try {
    body = b64urlDecode(state.slice(0, dot));
    mac = b64urlDecode(state.slice(dot + 1));
  } catch {
    return { ok: false, reason: "malformed state" };
  }

  // Signature first: never parse or act on bytes we have not authenticated.
  if (!(await crypto.subtle.verify("HMAC", key, mac, body))) {
    return { ok: false, reason: "bad state signature" };
  }

  let payload: Payload;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    payload = parsed as Payload;
  } catch {
    return { ok: false, reason: "malformed state" };
  }

  if (
    typeof payload.t !== "number" ||
    !Number.isFinite(payload.t) ||
    nowSeconds - payload.t > STATE_TTL_SECONDS ||
    payload.t - nowSeconds > CLOCK_SKEW_SECONDS
  ) {
    return { ok: false, reason: "state expired" };
  }

  // The browser binding. A signed state replayed from anywhere else dies here.
  //
  // The wording matters: this fires for ordinary reasons far more often than
  // hostile ones — a sign-in finished after its cookie expired, resumed in a
  // different browser, or completed after the user cleared cookies. Naming an
  // attack here would turn routine support questions into suspected breaches.
  if (typeof payload.n !== "string" || typeof payload.f !== "string") {
    return { ok: false, reason: "malformed state" };
  }
  const cookieNonce = readCookie(cookieHeader, stateCookieName(payload.f));
  if (!cookieNonce || !timingSafeEqual(payload.n, cookieNonce)) {
    return {
      ok: false,
      reason:
        "could not verify this sign-in in this browser. It may have expired, " +
        "or been started in a different browser. Start again from your client.",
    };
  }

  if (!payload.r || typeof payload.r !== "object") {
    return { ok: false, reason: "malformed state" };
  }
  return {
    ok: true,
    authRequest: payload.r,
    flow: { flowId: payload.f, nonce: cookieNonce },
    consented: payload.c === true,
  };
}

/** Read one cookie out of a request's Cookie header. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}

export function setStateCookie(flow: Flow): string {
  return (
    `${stateCookieName(flow.flowId)}=${flow.nonce}; Path=/; HttpOnly; Secure; ` +
    `SameSite=Lax; Max-Age=${STATE_TTL_SECONDS}`
  );
}

/**
 * Clear one flow's cookie once it is spent, so a finished nonce cannot be
 * reused. Abandoned flows are not cleared here — nothing comes back to do it —
 * but Max-Age bounds them to the TTL.
 */
export function clearStateCookie(flowId: string): string {
  return (
    `${stateCookieName(flowId)}=; Path=/; HttpOnly; Secure; SameSite=Lax; ` +
    `Max-Age=0`
  );
}
