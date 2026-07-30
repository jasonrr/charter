/**
 * Wiring tests for the upstream-connect routes, driven through the real
 * default export — the properties connect.test.ts structurally cannot see:
 *
 *  1. /connect/<id> mints a browser-bound cookie and 302s to the upstream.
 *  2. /connect/<id>/callback verifies that state before reading the code,
 *     rejects a state sealed for a different provider, and spends the cookie.
 *  3. A connect state cannot be redeemed as a sign-in grant at /callback.
 *  4. Unknown id -> 404; misconfigured id -> a named 503.
 *  5. The route is gated on its OWN config, not the sign-in route's, and on the
 *     configured origin (which is where the upstream's redirect_uri comes from).
 */
import { env as testEnv } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker, { type Env } from "../src/index.js";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// Must match wrangler.jsonc's CHARTER_GATEWAY_URL (gateway_url.ts refuses any other origin).
const ORIGIN = "https://charter-gateway.example.com";

const PROVIDERS = JSON.stringify({
  hs: {
    authorize_url: "https://app.hubspot.com/oauth/authorize",
    client_id: "cid-123",
    scopes: "oauth content",
    verb: "identity.hs.connect",
  },
  other: {
    authorize_url: "https://other.example/authorize",
    client_id: "cid-other",
    scopes: "read",
    verb: "identity.other.connect",
  },
});

function fullEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...(testEnv as Env),
    OAUTH_STATE_SECRET: "test-state-secret-0123456789",
    CHARTER_CONNECT_PROVIDERS: PROVIDERS,
    ...overrides,
  };
}

async function call(
  env: Env,
  path: string,
  init?: ConstructorParameters<typeof IncomingRequest>[1],
  origin = ORIGIN,
): Promise<Response> {
  const request = new IncomingRequest(`${origin}${path}`, init);
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** Start a real connect flow; returns the upstream state and the flow cookie. */
async function startConnect(env: Env, id = "hs") {
  const res = await call(env, `/connect/${id}`);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("Location") ?? "");
  const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0];
  return { state: location.searchParams.get("state") ?? "", cookie, location };
}

describe("/connect/<id>", () => {
  it("redirects to the upstream with the gateway's own callback URI", async () => {
    const { location, cookie } = await startConnect(fullEnv());
    expect(location.origin + location.pathname).toBe(
      "https://app.hubspot.com/oauth/authorize",
    );
    expect(location.searchParams.get("client_id")).toBe("cid-123");
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/connect/hs/callback`,
    );
    expect(location.searchParams.get("scope")).toBe("oauth content");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(cookie).toMatch(/^__Host-charter_state_/);
  });

  it("answers an unknown id exactly like any other unknown path", async () => {
    const env = fullEnv();
    const unknown = await call(env, "/connect/nope");
    const nonsense = await call(env, "/nonsense");
    expect(unknown.status).toBe(nonsense.status);
    expect(await unknown.text()).toBe(await nonsense.text());
  });

  it("404s an inherited property name instead of throwing", async () => {
    // A plain-object table would return Object.prototype's value here, skip the
    // 404 guard, and reach new URL(undefined) — an uncaught 500 on an
    // unauthenticated, guessable path.
    for (const id of ["constructor", "__proto__", "toString", "valueOf"]) {
      const res = await call(fullEnv(), `/connect/${id}`);
      expect(res.status, id).toBe(404);
    }
  });

  it("404s every provider when the table is unset", async () => {
    const res = await call(fullEnv({ CHARTER_CONNECT_PROVIDERS: undefined }), "/connect/hs");
    expect(res.status).toBe(404);
  });

  it("503s and names the field when the entry is configured but malformed", async () => {
    const broken = JSON.stringify({ hs: { authorize_url: "https://x.example/a", client_id: "", scopes: "", verb: "v" } });
    const res = await call(fullEnv({ CHARTER_CONNECT_PROVIDERS: broken }), "/connect/hs");
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain("CHARTER_CONNECT_PROVIDERS");
    expect(body).toContain("client_id");
  });

  it("503s and says so when the table itself will not parse", async () => {
    const res = await call(fullEnv({ CHARTER_CONNECT_PROVIDERS: "{" }), "/connect/hs");
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("not valid JSON");
  });

  it("503s on its own missing config, naming only what it needs", async () => {
    const res = await call(fullEnv({ OAUTH_STATE_SECRET: "" }), "/connect/hs");
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain("OAUTH_STATE_SECRET");
    // the Google values are the sign-in route's business, not connect's
    expect(body).not.toContain("GOOGLE_CLIENT_SECRET");
  });

  it("503s when reached on an origin that is not the configured one", async () => {
    // Matters more here than for sign-in: the upstream's redirect_uri is built
    // from CHARTER_GATEWAY_URL, so a foreign Host must not start a flow.
    const res = await call(fullEnv(), "/connect/hs", undefined, "https://evil.example.net");
    expect(res.status).toBe(503);
  });

  it("runs without any Google config at all", async () => {
    const res = await call(
      fullEnv({ GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" }),
      "/connect/hs",
    );
    expect(res.status).toBe(302);
  });
});

describe("/connect/<id>/callback", () => {
  it("hands back the tool call for a genuine round trip, and spends the cookie", async () => {
    const env = fullEnv();
    const { state, cookie } = await startConnect(env);
    const res = await call(env, `/connect/hs/callback?code=THE_CODE&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    // The nonce is spent; it must not authenticate a second callback.
    expect(res.headers.get("Set-Cookie")).toMatch(/^__Host-charter_state_.*Max-Age=0/);
    const body = await res.text();
    expect(body).toContain("identity.hs.connect");
    expect(body).toContain("THE_CODE");
  });

  it("rejects a state that did not come back in the same browser", async () => {
    const env = fullEnv();
    const { state } = await startConnect(env);
    const res = await call(env, `/connect/hs/callback?code=c&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(400);
  });

  it("will not spend one provider's state at another's callback", async () => {
    const env = fullEnv();
    const { state, cookie } = await startConnect(env, "hs");
    const res = await call(env, `/connect/other/callback?code=c&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("invalid state");
  });

  it("treats an upstream denial as a plain outcome, and still spends the cookie", async () => {
    const env = fullEnv();
    const { state, cookie } = await startConnect(env);
    const res = await call(
      env,
      `/connect/hs/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Nothing was connected");
    expect(res.headers.get("Set-Cookie")).toMatch(/Max-Age=0/);
  });

  it("rejects a verified state that carries no code", async () => {
    const env = fullEnv();
    const { state, cookie } = await startConnect(env);
    const res = await call(env, `/connect/hs/callback?state=${encodeURIComponent(state)}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(400);
  });

  // RFC 9207. The three negative-space cases matter as much as the positive
  // one: `iss` is only a SHOULD upstream, so absent must stay acceptable, and
  // an operator who has not configured an issuer has recorded nothing to
  // compare against.
  describe("issuer check (RFC 9207)", () => {
    const WITH_ISSUER = JSON.stringify({
      hs: {
        authorize_url: "https://app.hubspot.com/oauth/authorize",
        client_id: "cid-123",
        scopes: "oauth content",
        verb: "identity.hs.connect",
        issuer: "https://app.hubspot.com",
      },
    });

    async function callbackWith(env: Env, query: string) {
      const { state, cookie } = await startConnect(env);
      return call(
        env,
        `/connect/hs/callback?code=THE_CODE&state=${encodeURIComponent(state)}${query}`,
        { headers: { Cookie: cookie } },
      );
    }

    it("refuses a code whose iss is not the configured issuer, and spends the cookie", async () => {
      const env = fullEnv({ CHARTER_CONNECT_PROVIDERS: WITH_ISSUER });
      const res = await callbackWith(env, "&iss=https://evil.example");
      expect(res.status).toBe(400);
      expect(res.headers.get("Set-Cookie")).toMatch(/Max-Age=0/);
      const body = await res.text();
      expect(body).toContain("invalid issuer");
      // The whole point: the code never reaches the hand-off page.
      expect(body).not.toContain("THE_CODE");
    });

    it("accepts the matching iss", async () => {
      const env = fullEnv({ CHARTER_CONNECT_PROVIDERS: WITH_ISSUER });
      const res = await callbackWith(env, "&iss=https://app.hubspot.com");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("THE_CODE");
    });

    it("accepts an omitted iss — upstreams only SHOULD send one", async () => {
      const env = fullEnv({ CHARTER_CONNECT_PROVIDERS: WITH_ISSUER });
      const res = await callbackWith(env, "");
      expect(res.status).toBe(200);
    });

    it("ignores iss entirely when the provider has no configured issuer", async () => {
      // The default PROVIDERS table has no `issuer`, so there is nothing
      // recorded to validate against and the check must not invent one.
      const res = await callbackWith(fullEnv(), "&iss=https://anything.example");
      expect(res.status).toBe(200);
    });
  });
});

describe("connect state cannot become a sign-in grant", () => {
  it("is refused at /callback", async () => {
    // The direction that crosses trust domains. It holds because connect seals
    // with consented=false and /callback requires the flag — an invariant that
    // rests on an omitted argument, so it is pinned here.
    const env = fullEnv({
      GOOGLE_CLIENT_ID: "test-google-client",
      GOOGLE_CLIENT_SECRET: "test-google-secret",
    });
    const { state, cookie } = await startConnect(env);
    const res = await call(env, `/callback?code=c&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("not confirmed");
  });
});
