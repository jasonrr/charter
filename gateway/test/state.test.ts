import { describe, expect, it } from "vitest";
import {
  clearStateCookie,
  importStateKey,
  mintNonce,
  openState,
  readCookie,
  sealState,
  setStateCookie,
  STATE_COOKIE,
} from "../src/state.js";

const NOW = 1_800_000_000;
const REQ = { clientId: "abc", redirectUri: "https://client.example/cb", scope: [] };

const key = () => importStateKey("a-signing-secret");

// base64url without Buffer — this package has no node types, and the Worker
// runtime these tests stand in for has no Buffer either.
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlOfText(text: string): string {
  return b64url(new TextEncoder().encode(text));
}

function bytesOfB64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

describe("sealState / openState", () => {
  it("round-trips the auth request when signature, nonce and TTL all hold", async () => {
    const k = await key();
    const nonce = mintNonce();
    const state = await sealState(k, REQ, nonce, NOW);
    const r = await openState(k, state, nonce, NOW + 5);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.authRequest).toEqual(REQ);
  });

  it("survives a client state containing non-Latin-1 characters", async () => {
    const k = await key();
    const nonce = mintNonce();
    const req = { ...REQ, state: "café—日本語" };
    const state = await sealState(k, req, nonce, NOW);
    const r = await openState(k, state, nonce, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.authRequest).toEqual(req);
  });

  it("rejects a tampered payload", async () => {
    const k = await key();
    const nonce = mintNonce();
    const state = await sealState(k, REQ, nonce, NOW);
    // Re-encode a different auth request under the original signature.
    const forgedBody = b64urlOfText(
      JSON.stringify({ r: { ...REQ, redirectUri: "https://attacker.example/x" }, n: nonce, t: NOW }),
    );
    const forged = `${forgedBody}.${state.split(".")[1]}`;
    const r = await openState(k, forged, nonce, NOW);
    expect(r).toEqual({ ok: false, reason: "bad state signature" });
  });

  it("rejects a flipped signature", async () => {
    const k = await key();
    const nonce = mintNonce();
    const state = await sealState(k, REQ, nonce, NOW);
    const [body, mac] = state.split(".");
    const flipped = `${body}.${mac.slice(0, -1)}${mac.slice(-1) === "A" ? "B" : "A"}`;
    const r = await openState(k, flipped, nonce, NOW);
    expect(r.ok).toBe(false);
  });

  it("rejects a state signed with a different key", async () => {
    const nonce = mintNonce();
    const state = await sealState(await importStateKey("attacker-secret"), REQ, nonce, NOW);
    const r = await openState(await key(), state, nonce, NOW);
    expect(r).toEqual({ ok: false, reason: "bad state signature" });
  });

  it("rejects a legitimately signed state replayed from another browser", async () => {
    // The attack the signature alone does not stop: the attacker can have us
    // sign a state of their own, so only the cookie tells the browsers apart.
    const k = await key();
    const attackerNonce = mintNonce();
    const state = await sealState(k, REQ, attackerNonce, NOW);
    const r = await openState(k, state, mintNonce(), NOW);
    expect(r).toEqual({ ok: false, reason: "state did not come from this browser" });
  });

  it("rejects a valid state with no cookie at all", async () => {
    const k = await key();
    const nonce = mintNonce();
    const state = await sealState(k, REQ, nonce, NOW);
    const r = await openState(k, state, null, NOW);
    expect(r).toEqual({ ok: false, reason: "state did not come from this browser" });
  });

  it("rejects an expired state", async () => {
    const k = await key();
    const nonce = mintNonce();
    const state = await sealState(k, REQ, nonce, NOW);
    const r = await openState(k, state, nonce, NOW + 601);
    expect(r).toEqual({ ok: false, reason: "state expired" });
  });

  it("accepts a state right at the TTL boundary", async () => {
    const k = await key();
    const nonce = mintNonce();
    const state = await sealState(k, REQ, nonce, NOW);
    expect((await openState(k, state, nonce, NOW + 600)).ok).toBe(true);
  });

  it("rejects a state issued implausibly far in the future", async () => {
    const k = await key();
    const nonce = mintNonce();
    const state = await sealState(k, REQ, nonce, NOW + 3600);
    const r = await openState(k, state, nonce, NOW);
    expect(r).toEqual({ ok: false, reason: "state expired" });
  });

  it.each(["", ".", "notdotted", "a.", ".b", "!!!.!!!"])(
    "rejects malformed state %j without throwing",
    async (bad) => {
      const r = await openState(await key(), bad, "n", NOW);
      expect(r.ok).toBe(false);
    },
  );

  it("rejects a signed payload whose auth request is not an object", async () => {
    const k = await key();
    const nonce = mintNonce();
    // Signed by us, so it clears the MAC — the shape check is what stops it.
    const body = b64urlOfText(JSON.stringify({ r: null, n: nonce, t: NOW }));
    const mac = b64url(
      new Uint8Array(await crypto.subtle.sign("HMAC", k, bytesOfB64url(body))),
    );
    const r = await openState(k, `${body}.${mac}`, nonce, NOW);
    expect(r).toEqual({ ok: false, reason: "malformed state" });
  });

  it("mints a distinct nonce each time", () => {
    const seen = new Set(Array.from({ length: 50 }, () => mintNonce()));
    expect(seen.size).toBe(50);
  });
});

describe("cookies", () => {
  it("reads its own cookie out of a crowded header", () => {
    const header = `other=1; ${STATE_COOKIE}=abc123; trailing=2`;
    expect(readCookie(header, STATE_COOKIE)).toBe("abc123");
  });

  it("returns null when absent, empty or headerless", () => {
    expect(readCookie(null, STATE_COOKIE)).toBeNull();
    expect(readCookie("", STATE_COOKIE)).toBeNull();
    expect(readCookie("other=1", STATE_COOKIE)).toBeNull();
  });

  it("does not match a cookie whose name merely ends with ours", () => {
    expect(readCookie(`not${STATE_COOKIE}=nope`, STATE_COOKIE)).toBeNull();
  });

  it("sets the attributes the __Host- prefix requires", () => {
    const c = setStateCookie("n1");
    expect(c).toContain(`${STATE_COOKIE}=n1`);
    expect(c).toContain("Path=/");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).not.toContain("Domain=");
  });

  it("clears with Max-Age=0", () => {
    expect(clearStateCookie()).toContain("Max-Age=0");
  });
});
