/**
 * Wiring-order tests for src/index.ts — the properties the helper unit tests
 * structurally cannot see, driven through the real default export:
 *
 *  1. /callback requires the consent flag: a signed, cookie-bound state that
 *     skipped the consent screen is rejected, before any Google round-trip.
 *  2. Signature before parse: a tampered state dies at openState's HMAC check,
 *     before any Google round-trip.
 *  3. 401s from /mcp carry RFC 9728's resource_metadata parameter.
 *
 * Each flow test registers its own client and mints its own state through the
 * real routes (isolatedStorage resets KV between tests, so nothing can be
 * shared across `it` blocks).
 */
import { env as testEnv } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { type Env } from "../src/index.js";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// Must match wrangler.jsonc's CHARTER_GATEWAY_URL — sign-in refuses to run on
// any other origin (gateway_url.ts), which is itself part of the wiring.
const ORIGIN = "https://charter-gateway.example.com";
const REDIRECT_URI = "http://localhost:33418/cb";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** wrangler.jsonc leaves the secrets unset; fill in what the auth routes require. */
function fullEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...(testEnv as Env),
    GOOGLE_CLIENT_ID: "test-google-client",
    GOOGLE_CLIENT_SECRET: "test-google-secret",
    OAUTH_STATE_SECRET: "test-state-secret-0123456789",
    ...overrides,
  };
}

async function call(
  env: Env,
  path: string,
  init?: ConstructorParameters<typeof IncomingRequest>[1],
): Promise<Response> {
  const request = new IncomingRequest(`${ORIGIN}${path}`, init);
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/**
 * Drive the real front half of a sign-in: register a client, then GET
 * /authorize. Returns the signed (unconsented) state from the consent page's
 * hidden input and the flow cookie that binds it to "this browser".
 */
async function startFlow(env: Env): Promise<{ state: string; cookie: string }> {
  const reg = await call(env, "/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(reg.status).toBeLessThan(300);
  const { client_id } = (await reg.json()) as { client_id: string };

  const authorize = await call(
    env,
    "/authorize?" +
      new URLSearchParams({
        response_type: "code",
        client_id,
        redirect_uri: REDIRECT_URI,
        state: "client-state",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
      }).toString(),
  );
  expect(authorize.status).toBe(200);

  const html = await authorize.text();
  const state = /name="state" value="([^"]+)"/.exec(html)?.[1];
  const cookie = authorize.headers.get("Set-Cookie")?.split(";")[0];
  expect(state).toBeTruthy();
  expect(cookie).toMatch(/^__Host-charter_state_/);
  return { state: state!, cookie: cookie! };
}

/** POST the consent form; returns the re-sealed, consented state Google would echo back. */
async function consent(env: Env, state: string, cookie: string): Promise<string> {
  const res = await call(env, "/authorize/continue", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookie,
    },
    body: new URLSearchParams({ state }).toString(),
  });
  expect(res.status).toBe(302);
  const location = res.headers.get("Location")!;
  expect(location).toContain("accounts.google.com");
  return new URL(location).searchParams.get("state")!;
}

/** Record every upstream fetch the worker makes; answer with a plain 500. */
function spyOnUpstreamFetch(): string[] {
  const seen: string[] = [];
  vi.stubGlobal("fetch", (async (url: unknown) => {
    seen.push(String(url));
    return new Response("upstream unavailable", { status: 500 });
  }) as typeof fetch);
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe("/callback wiring order", () => {
  it("rejects a signed, cookie-bound state that skipped the consent screen — before any Google call", async () => {
    const env = fullEnv();
    const { state, cookie } = await startFlow(env);

    const upstream = spyOnUpstreamFetch();
    const res = await call(env, `/callback?state=${encodeURIComponent(state)}&code=x`, {
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("not confirmed");
    expect(upstream).toEqual([]);
  });

  it("rejects a tampered state at the signature check — before parsing it or calling Google", async () => {
    const env = fullEnv();
    const { state, cookie } = await consentedFlow(env);

    // Flip one mid-payload character. Mid, not last: the final base64url char
    // of a segment carries padding bits, and flipping only those decodes to
    // the same bytes (the 1-in-16 flaky-test trap found in review §5).
    const i = 10;
    const tampered =
      state.slice(0, i) + (state[i] === "A" ? "B" : "A") + state.slice(i + 1);
    expect(tampered).not.toBe(state);

    const upstream = spyOnUpstreamFetch();
    const res = await call(env, `/callback?state=${encodeURIComponent(tampered)}&code=x`, {
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("bad state signature");
    expect(upstream).toEqual([]);
  });

  it("a consented state proceeds through the redirect-URI re-check to the Google exchange", async () => {
    const env = fullEnv();
    const { state, cookie } = await consentedFlow(env);

    // Positive control for the two tests above: same route, same cookie, and
    // the only difference — consent recorded inside the signed state — is what
    // lets the request reach the code exchange. The stubbed 500 makes the
    // exchange fail, which is enough: the wiring under test ends where the
    // Google round-trip begins.
    const upstream = spyOnUpstreamFetch();
    const res = await call(env, `/callback?state=${encodeURIComponent(state)}&code=fake`, {
      headers: { Cookie: cookie },
    });

    expect(upstream).toContain(GOOGLE_TOKEN_URL);
    expect(res.status).toBe(403);
  });

  async function consentedFlow(env: Env): Promise<{ state: string; cookie: string }> {
    const started = await startFlow(env);
    const state = await consent(env, started.state, started.cookie);
    return { state, cookie: started.cookie };
  }
});

describe("PKCE S256 enforcement (allowPlainPKCE: false)", () => {
  it("advertises only S256 in the authorization-server metadata", async () => {
    const res = await call(fullEnv(), "/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const metadata = (await res.json()) as { code_challenge_methods_supported: string[] };
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("rejects an /authorize request whose code_challenge_method is plain", async () => {
    const env = fullEnv();
    const reg = await call(env, "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "none",
      }),
    });
    const { client_id } = (await reg.json()) as { client_id: string };

    // No code_challenge_method at all defaults to plain in the provider, so
    // this also pins "PKCE is required", not merely "plain is refused".
    const variants: Record<string, string>[] = [
      { code_challenge: "x".repeat(43), code_challenge_method: "plain" },
      {},
    ];
    for (const extra of variants) {
      const res = await call(
        env,
        "/authorize?" +
          new URLSearchParams({
            response_type: "code",
            client_id,
            redirect_uri: REDIRECT_URI,
            state: "client-state",
            ...extra,
          }).toString(),
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("plain PKCE method is not allowed");
    }
  });
});

describe("401 resource_metadata decoration (RFC 9728 discovery mechanism 1)", () => {
  it("adds resource_metadata to a 401 from /mcp", async () => {
    const res = await call(fullEnv(), "/mcp", { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("advertises the configured origin even when the request arrives on a foreign Host", async () => {
    // The provider (>=0.8) decorates 401s itself with a URL derived from the
    // request's own origin — steerable by whoever set the Host. The gateway
    // must replace it with the configured one (same reason as prm.ts).
    const request = new IncomingRequest("https://evil.example.net/mcp", { method: "POST" });
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, fullEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(401);
    const header = res.headers.get("WWW-Authenticate")!;
    expect(header).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(header).not.toContain("evil.example.net");
  });

  it("leaves the 401 undecorated when CHARTER_GATEWAY_URL is invalid — never publishes a bad origin", async () => {
    const env = fullEnv({ CHARTER_GATEWAY_URL: "not a url" });
    const res = await call(env, "/mcp", { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate") ?? "").not.toContain("resource_metadata");
  });
});
