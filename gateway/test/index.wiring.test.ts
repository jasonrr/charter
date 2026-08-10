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

  // RFC 9207. The existing test above is the "no iss at all" case — it reaches
  // the exchange — so only the two iss-bearing cases are new here.
  it("refuses a callback naming an issuer that is not Google — before any Google call", async () => {
    const env = fullEnv();
    const { state, cookie } = await consentedFlow(env);

    const upstream = spyOnUpstreamFetch();
    const res = await call(
      env,
      `/callback?state=${encodeURIComponent(state)}&code=fake&iss=${encodeURIComponent("https://evil.example")}`,
      { headers: { Cookie: cookie } },
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("invalid issuer");
    expect(upstream).toEqual([]);
  });

  it("proceeds when the callback names Google's own issuer", async () => {
    const env = fullEnv();
    const { state, cookie } = await consentedFlow(env);

    const upstream = spyOnUpstreamFetch();
    const res = await call(
      env,
      `/callback?state=${encodeURIComponent(state)}&code=fake&iss=${encodeURIComponent("https://accounts.google.com")}`,
      { headers: { Cookie: cookie } },
    );

    expect(upstream).toContain(GOOGLE_TOKEN_URL);
    expect(res.status).toBe(403);
  });

  // The other half of RFC 9207: charter is an authorization server here, and
  // must name itself on the response it sends back to the MCP client. A wrong
  // value is worse than none — a client that validates `iss` rejects the code —
  // so pin it to the origin the client would have read our metadata from.
  it("names itself as the issuer on the redirect back to the client", async () => {
    const env = fullEnv();
    const { state, cookie } = await consentedFlow(env);

    stubGoogleSignIn("someone@example.com");
    const res = await call(env, `/callback?state=${encodeURIComponent(state)}&code=good`, {
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("Location")!);
    expect(back.origin + back.pathname).toBe(REDIRECT_URI);
    expect(back.searchParams.get("code")).toBeTruthy();
    expect(back.searchParams.get("iss")).toBe(ORIGIN);
    // The client's own `state` still has to survive alongside it.
    expect(back.searchParams.get("state")).toBe("client-state");
  });

  /** Answer Google's token endpoint with a usable identity for `email`. */
  function stubGoogleSignIn(email: string): void {
    const b64url = (o: unknown) =>
      btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    // Unsigned on purpose: nothing in the gateway verifies this — core does
    // (google.ts's header comment). decodeIdTokenClaims only reads the payload.
    const idToken = `${b64url({ alg: "none" })}.${b64url({
      email,
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}.`;
    vi.stubGlobal("fetch", (async () =>
      new Response(
        JSON.stringify({ id_token: idToken, refresh_token: "refresh-abc" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch);
  }

  async function consentedFlow(env: Env): Promise<{ state: string; cookie: string }> {
    const started = await startFlow(env);
    const state = await consent(env, started.state, started.cookie);
    return { state, cookie: started.cookie };
  }
});

/**
 * Client ID Metadata Documents (spec 2026-07-28 deprecates DCR in favour of
 * them). A CIMD client never POSTs to /register, so screenRegistration never
 * sees it — these tests are the evidence that the redirect-URI control still
 * applies to it, enforced at /authorize instead.
 */
describe("CIMD (client_id as a metadata document URL)", () => {
  const CIMD_URL = "https://client.example/mcp-client.json";

  /** Serve a metadata document for CIMD_URL; 404 anything else. */
  function stubMetadata(doc: Record<string, unknown>): void {
    vi.stubGlobal("fetch", (async (input: unknown) =>
      String(input) === CIMD_URL
        ? new Response(JSON.stringify(doc), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        : new Response("not found", { status: 404 })) as typeof fetch);
  }

  function authorizeAs(env: Env, redirectUri: string) {
    return call(
      env,
      "/authorize?" +
        new URLSearchParams({
          response_type: "code",
          client_id: CIMD_URL,
          redirect_uri: redirectUri,
          state: "client-state",
          code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
          code_challenge_method: "S256",
        }).toString(),
    );
  }

  it("advertises CIMD support, which is also proof the SSRF compat flag is live", async () => {
    // The provider only advertises this when clientIdMetadataDocumentEnabled
    // AND global_fetch_strictly_public are both on, so one assertion covers the
    // wrangler.jsonc half — the half nothing else in the suite would catch.
    const res = await call(fullEnv(), "/.well-known/oauth-authorization-server");
    const metadata = (await res.json()) as Record<string, unknown>;
    expect(metadata.client_id_metadata_document_supported).toBe(true);
  });

  it("refuses a CIMD client whose document points the code at its own server", async () => {
    stubMetadata({
      client_id: CIMD_URL,
      client_name: "Perfectly Normal Client",
      redirect_uris: ["https://evil.example/collect"],
      token_endpoint_auth_method: "none",
    });

    const res = await authorizeAs(fullEnv(), "https://evil.example/collect");

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("will not send an authorization code");
  });

  it("accepts a CIMD client with a loopback redirect_uri", async () => {
    // Positive control: same route, same document shape, and the only
    // difference is a redirect_uri that cannot be collected remotely.
    stubMetadata({
      client_id: CIMD_URL,
      client_name: "Perfectly Normal Client",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
    });

    const res = await authorizeAs(fullEnv(), REDIRECT_URI);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("localhost");
  });
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
      // Provider 0.9+ phrases both refusals as a PKCE requirement ("Public
      // clients must use PKCE with the authorization code flow.") rather than
      // naming the plain method; the 400 is the contract, the wording isn't.
      expect(await res.text()).toContain("PKCE");
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
