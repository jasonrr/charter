import { describe, expect, it } from "vitest";
import {
  clearStateCookie,
  importStateKey,
  mintFlow,
  mintNonce,
  openState,
  readCookie,
  sealState,
  setStateCookie,
  stateCookieName,
  STATE_COOKIE_PREFIX,
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

/** The Cookie header a browser would send back for these flows. */
function jar(...flows: { flowId: string; nonce: string }[]): string {
  return flows.map((f) => `${stateCookieName(f.flowId)}=${f.nonce}`).join("; ");
}

function bytesOfB64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

describe("sealState / openState", () => {
  it("round-trips the auth request when signature, nonce and TTL all hold", async () => {
    const k = await key();
    const f = mintFlow();
    const state = await sealState(k, REQ, f, NOW);
    const r = await openState(k, state, jar(f), NOW + 5);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.authRequest).toEqual(REQ);
      expect(r.flowId).toBe(f.flowId);
    }
  });

  it("survives a client state containing non-Latin-1 characters", async () => {
    const k = await key();
    const f = mintFlow();
    const req = { ...REQ, state: "café—日本語" };
    const state = await sealState(k, req, f, NOW);
    const r = await openState(k, state, jar(f), NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.authRequest).toEqual(req);
  });

  // Two sign-ins started in one browser must both stay completable: a second
  // MCP client, or just a double-clicked connect button, is the common case.
  it("lets either of two concurrent flows in one browser complete", async () => {
    const k = await key();
    const first = mintFlow();
    const second = mintFlow();
    const a = await sealState(k, { ...REQ, clientId: "first" }, first, NOW);
    const b = await sealState(k, { ...REQ, clientId: "second" }, second, NOW);
    const both = jar(first, second);

    const ra = await openState(k, a, both, NOW);
    const rb = await openState(k, b, both, NOW);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    if (ra.ok) expect((ra.authRequest as { clientId: string }).clientId).toBe("first");
    if (rb.ok) expect((rb.authRequest as { clientId: string }).clientId).toBe("second");
  });

  it("completing the older flow still works after a newer one starts", async () => {
    const k = await key();
    const older = mintFlow();
    const state = await sealState(k, REQ, older, NOW);
    const newer = mintFlow();
    await sealState(k, REQ, newer, NOW + 1);
    expect((await openState(k, state, jar(older, newer), NOW + 2)).ok).toBe(true);
  });

  it("rejects a tampered payload", async () => {
    const k = await key();
    const f = mintFlow();
    const state = await sealState(k, REQ, f, NOW);
    // Re-encode a different auth request under the original signature.
    const forgedBody = b64urlOfText(
      JSON.stringify({
        r: { ...REQ, redirectUri: "https://attacker.example/x" },
        n: f.nonce,
        f: f.flowId,
        t: NOW,
      }),
    );
    const forged = `${forgedBody}.${state.split(".")[1]}`;
    const r = await openState(k, forged, jar(f), NOW);
    expect(r).toEqual({ ok: false, reason: "bad state signature" });
  });

  it("rejects a flipped signature", async () => {
    const k = await key();
    const f = mintFlow();
    const state = await sealState(k, REQ, f, NOW);
    const [body, mac] = state.split(".");
    const flipped = `${body}.${mac.slice(0, -1)}${mac.slice(-1) === "A" ? "B" : "A"}`;
    expect((await openState(k, flipped, jar(f), NOW)).ok).toBe(false);
  });

  it("rejects a state signed with a different key", async () => {
    const f = mintFlow();
    const state = await sealState(await importStateKey("attacker-secret"), REQ, f, NOW);
    const r = await openState(await key(), state, jar(f), NOW);
    expect(r).toEqual({ ok: false, reason: "bad state signature" });
  });

  it("rejects a legitimately signed state replayed from another browser", async () => {
    // The attack the signature alone does not stop: the attacker can have us
    // sign a state of their own, so only the cookie tells the browsers apart.
    const k = await key();
    const attacker = mintFlow();
    const state = await sealState(k, REQ, attacker, NOW);
    const r = await openState(k, state, jar(mintFlow()), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could not verify this sign-in/);
  });

  it("rejects the right flow id carrying the wrong nonce", async () => {
    const k = await key();
    const f = mintFlow();
    const state = await sealState(k, REQ, f, NOW);
    const r = await openState(k, state, jar({ flowId: f.flowId, nonce: mintNonce() }), NOW);
    expect(r.ok).toBe(false);
  });

  it("rejects a valid state with no cookies at all", async () => {
    const k = await key();
    const f = mintFlow();
    const state = await sealState(k, REQ, f, NOW);
    expect((await openState(k, state, null, NOW)).ok).toBe(false);
  });

  it("blames the browser, not an attacker, when the cookie is gone", async () => {
    // This fires for expiry and cleared cookies far more often than for an
    // attack, so the wording must not read like a breach report.
    const k = await key();
    const f = mintFlow();
    const state = await sealState(k, REQ, f, NOW);
    const r = await openState(k, state, null, NOW);
    if (r.ok) throw new Error("expected failure");
    expect(r.reason).not.toMatch(/attack|forged|malicious/i);
    expect(r.reason).toMatch(/expired|different browser/i);
    expect(r.reason).toMatch(/start again/i);
  });

  it("rejects an expired state", async () => {
    const k = await key();
    const f = mintFlow();
    const state = await sealState(k, REQ, f, NOW);
    const r = await openState(k, state, jar(f), NOW + 601);
    expect(r).toEqual({ ok: false, reason: "state expired" });
  });

  it("accepts a state right at the TTL boundary", async () => {
    const k = await key();
    const f = mintFlow();
    const state = await sealState(k, REQ, f, NOW);
    expect((await openState(k, state, jar(f), NOW + 600)).ok).toBe(true);
  });

  it("rejects a state issued implausibly far in the future", async () => {
    const k = await key();
    const f = mintFlow();
    const state = await sealState(k, REQ, f, NOW + 3600);
    const r = await openState(k, state, jar(f), NOW);
    expect(r).toEqual({ ok: false, reason: "state expired" });
  });

  // Separator parsing: no dot, nothing before it, nothing after it. A truncated
  // or empty MAC must not read as "no signature to check".
  it.each([
    ["no separator", "onlybody"],
    ["separator only", "."],
    ["empty body", ".bWFj"],
    ["empty mac", "Ym9keQ."],
    ["empty string", ""],
    ["non-base64 halves", "!!!.!!!"],
  ])("rejects %s without throwing", async (_label, bad) => {
    const r = await openState(await key(), bad, "cookie=x", NOW);
    expect(r.ok).toBe(false);
  });

  it("rejects a truncated MAC that is still valid base64url", async () => {
    const k = await key();
    const f = mintFlow();
    const [body, mac] = (await sealState(k, REQ, f, NOW)).split(".");
    expect((await openState(k, `${body}.${mac.slice(0, 10)}`, jar(f), NOW)).ok).toBe(false);
  });

  it("rejects a signed payload whose auth request is not an object", async () => {
    const k = await key();
    const f = mintFlow();
    // Signed by us, so it clears the MAC — the shape check is what stops it.
    const body = b64urlOfText(JSON.stringify({ r: null, n: f.nonce, f: f.flowId, t: NOW }));
    const mac = b64url(
      new Uint8Array(await crypto.subtle.sign("HMAC", k, bytesOfB64url(body))),
    );
    const r = await openState(k, `${body}.${mac}`, jar(f), NOW);
    expect(r).toEqual({ ok: false, reason: "malformed state" });
  });

  it("mints a distinct nonce and flow id each time", () => {
    const flows = Array.from({ length: 50 }, () => mintFlow());
    expect(new Set(flows.map((f) => f.nonce)).size).toBe(50);
    expect(new Set(flows.map((f) => f.flowId)).size).toBe(50);
  });
});

describe("cookies", () => {
  const NAME = stateCookieName("f1");

  it("reads its own cookie out of a crowded header", () => {
    expect(readCookie(`other=1; ${NAME}=abc123; trailing=2`, NAME)).toBe("abc123");
  });

  it("returns null when absent, empty or headerless", () => {
    expect(readCookie(null, NAME)).toBeNull();
    expect(readCookie("", NAME)).toBeNull();
    expect(readCookie("other=1", NAME)).toBeNull();
  });

  it("does not match a cookie whose name merely ends with ours", () => {
    expect(readCookie(`not${NAME}=nope`, NAME)).toBeNull();
  });

  it("keeps concurrent flows in separate cookies", () => {
    expect(stateCookieName("a")).not.toBe(stateCookieName("b"));
    expect(stateCookieName("a").startsWith(STATE_COOKIE_PREFIX)).toBe(true);
  });

  it("sets the attributes the __Host- prefix requires", () => {
    const c = setStateCookie({ flowId: "f1", nonce: "n1" });
    expect(c).toContain(`${NAME}=n1`);
    expect(c).toContain("Path=/");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).not.toContain("Domain=");
  });

  it("clears only the named flow, with Max-Age=0", () => {
    const c = clearStateCookie("f1");
    expect(c).toContain(`${NAME}=;`);
    expect(c).toContain("Max-Age=0");
  });
});
