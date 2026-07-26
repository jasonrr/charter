import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  decodeIdTokenClaims,
  exchangeCode,
  freshIdToken,
  type GoogleConfig,
  type GoogleIdentity,
} from "../src/google.js";

const CFG: GoogleConfig = {
  clientId: "cid.apps.googleusercontent.com",
  clientSecret: "csecret",
  redirectUri: "https://gw.example.com/callback",
  allowedDomain: "@example.com",
};

/** Build an unsigned JWT with the given payload — shape only, never verified here. */
function jwt(payload: object): string {
  const b64 = (o: object) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

function fakeFetch(bodies: object[]) {
  const seen: { url: string; body: string }[] = [];
  let i = 0;
  const impl = (async (url: any, init: any) => {
    seen.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response(JSON.stringify(bodies[i++]), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

describe("buildAuthorizeUrl", () => {
  it("requests openid email with offline access and forced consent", () => {
    const u = new URL(buildAuthorizeUrl(CFG, "st4te"));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe(CFG.clientId);
    expect(u.searchParams.get("redirect_uri")).toBe(CFG.redirectUri);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("openid email");
    expect(u.searchParams.get("state")).toBe("st4te");
    // offline + consent are what make a refresh token arrive (§4.6 freshness).
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
  });

  it("hints the work domain so the account chooser defaults correctly", () => {
    const u = new URL(buildAuthorizeUrl(CFG, "s"));
    expect(u.searchParams.get("hd")).toBe("example.com");
  });
});

describe("decodeIdTokenClaims", () => {
  it("reads the payload segment", () => {
    const c = decodeIdTokenClaims(jwt({ email: "a@example.com", exp: 42 }));
    expect(c.email).toBe("a@example.com");
    expect(c.exp).toBe(42);
  });

  it("returns an empty object for a malformed token rather than throwing", () => {
    expect(decodeIdTokenClaims("not-a-jwt")).toEqual({});
    expect(decodeIdTokenClaims("")).toEqual({});
  });
});

describe("exchangeCode", () => {
  it("posts the code and returns the identity with its refresh token", async () => {
    const idToken = jwt({
      email: "jason@example.com",
      email_verified: true,
      exp: 1000,
    });
    const { impl, seen } = fakeFetch([
      { id_token: idToken, refresh_token: "r3fresh", expires_in: 3600 },
    ]);
    const got = await exchangeCode(impl, CFG, "thecode");
    expect(got.email).toBe("jason@example.com");
    expect(got.idToken).toBe(idToken);
    expect(got.idTokenExp).toBe(1000);
    expect(got.refreshToken).toBe("r3fresh");
    expect(seen[0].url).toBe("https://oauth2.googleapis.com/token");
    const sent = new URLSearchParams(seen[0].body);
    expect(sent.get("code")).toBe("thecode");
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("redirect_uri")).toBe(CFG.redirectUri);
  });

  it("rejects an account outside the allowed domain", async () => {
    const { impl } = fakeFetch([
      {
        id_token: jwt({ email: "x@other.com", email_verified: true, exp: 1000 }),
        refresh_token: "r",
        expires_in: 3600,
      },
    ]);
    await expect(exchangeCode(impl, CFG, "c")).rejects.toThrow(/example\.com/);
  });

  it("rejects an unverified email", async () => {
    const { impl } = fakeFetch([
      {
        id_token: jwt({ email: "x@example.com", email_verified: false, exp: 1000 }),
        refresh_token: "r",
        expires_in: 3600,
      },
    ]);
    await expect(exchangeCode(impl, CFG, "c")).rejects.toThrow(/verified/);
  });

  it("rejects a response with no refresh token", async () => {
    // Without one there is no way to stay fresh past an hour (§4.6).
    const { impl } = fakeFetch([
      {
        id_token: jwt({ email: "x@example.com", email_verified: true, exp: 1000 }),
        expires_in: 3600,
      },
    ]);
    await expect(exchangeCode(impl, CFG, "c")).rejects.toThrow(/refresh token/);
  });

  it("never puts the client secret in a thrown error", async () => {
    const impl = (async () =>
      new Response("upstream failure csecret", { status: 500 })) as unknown as typeof fetch;
    let caught: unknown;
    try {
      await exchangeCode(impl, CFG, "c");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain("csecret");
  });
});

describe("freshIdToken", () => {
  const identity: GoogleIdentity = {
    email: "jason@example.com",
    idToken: jwt({ email: "jason@example.com", exp: 5000 }),
    idTokenExp: 5000,
    refreshToken: "r3fresh",
  };

  it("reuses the cached token while it is still valid", async () => {
    const { impl, seen } = fakeFetch([]);
    const got = await freshIdToken(impl, CFG, identity, 4000);
    expect(got.idToken).toBe(identity.idToken);
    expect(seen).toHaveLength(0);
  });

  it("re-mints when the token is within the refresh margin of expiry", async () => {
    const next = jwt({ email: "jason@example.com", exp: 9000 });
    const { impl, seen } = fakeFetch([{ id_token: next, expires_in: 3600 }]);
    const got = await freshIdToken(impl, CFG, identity, 4990);
    expect(got.idToken).toBe(next);
    expect(got.identity.idTokenExp).toBe(9000);
    // The refresh token is carried forward — Google need not return a new one.
    expect(got.identity.refreshToken).toBe("r3fresh");
    const sent = new URLSearchParams(seen[0].body);
    expect(sent.get("grant_type")).toBe("refresh_token");
    expect(sent.get("refresh_token")).toBe("r3fresh");
  });

  it("re-mints when the token is already expired", async () => {
    const next = jwt({ email: "jason@example.com", exp: 9000 });
    const { impl } = fakeFetch([{ id_token: next, expires_in: 3600 }]);
    const got = await freshIdToken(impl, CFG, identity, 6000);
    expect(got.idToken).toBe(next);
  });

  it("adopts a rotated refresh token when Google returns one", async () => {
    const next = jwt({ email: "jason@example.com", exp: 9000 });
    const { impl } = fakeFetch([
      { id_token: next, refresh_token: "rotated", expires_in: 3600 },
    ]);
    const got = await freshIdToken(impl, CFG, identity, 6000);
    expect(got.identity.refreshToken).toBe("rotated");
  });

  it("surfaces a revoked grant as an error naming re-authentication", async () => {
    const impl = (async () =>
      new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch;
    await expect(freshIdToken(impl, CFG, identity, 6000)).rejects.toThrow(/sign in again/i);
  });
});
