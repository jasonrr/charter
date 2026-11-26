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
async function startFlow(
  env: Env,
  extra: Record<string, string> = {},
): Promise<{ state: string; cookie: string; clientId: string }> {
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
        ...extra,
      }).toString(),
  );
  expect(authorize.status).toBe(200);

  const html = await authorize.text();
  const state = /name="state" value="([^"]+)"/.exec(html)?.[1];
  const cookie = authorize.headers.get("Set-Cookie")?.split(";")[0];
  expect(state).toBeTruthy();
  expect(cookie).toMatch(/^__Host-charter_state_/);
  return { state: state!, cookie: cookie!, clientId: client_id };
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

const VERIFIER = "charter-e2e-verifier-0123456789-abcdefghijklmnop"; // RFC 7636: 43-128 chars of [A-Za-z0-9-._~]
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const RESOURCE = `${ORIGIN}/mcp`;

afterEach(() => vi.unstubAllGlobals());

describe("consent page CSP", () => {
  // The consent form posts to /authorize/continue, which 302s to Google. Chrome
  // enforces form-action across the submission's redirect chain, so 'self' alone
  // silently blocks the hop to Google and "Continue" appears to do nothing. The
  // directive must name the Google origin too.
  it("allows the Google auth origin in form-action, not just 'self'", async () => {
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
    const csp = authorize.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("form-action 'self' https://accounts.google.com");
  });
});

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

  it("renders a local 400, never a redirect or the URL, when the metadata document can't be fetched", async () => {
    vi.stubGlobal("fetch", (async () => new Response("down", { status: 503 })) as typeof fetch);
    const res = await call(fullEnv(), "/authorize?" + new URLSearchParams({
      response_type: "code",
      client_id: CIMD_URL,
      redirect_uri: "https://client.example/cb",
      state: "s",
      code_challenge: await s256(VERIFIER),
      code_challenge_method: "S256",
    }).toString());
    const body = await res.text();
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
    expect(body).not.toContain(CIMD_URL);
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

describe("PKCE S256 enforcement", () => {
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
    // Provider 1.x omits resource_metadata for a foreign-origin request (0.x
    // derived it from the Host). Either way the gateway must advertise the
    // configured one (same reason as prm.ts).
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

  it("leaves the 503 undecorated when CHARTER_GATEWAY_URL is invalid — never publishes a bad origin", async () => {
    const env = fullEnv({ CHARTER_GATEWAY_URL: "not a url" });
    const res = await call(env, "/mcp", { method: "POST" });
    await res.text();
    expect(res.status).toBe(503);
    expect(res.headers.get("WWW-Authenticate") ?? "").not.toContain("resource_metadata");
  });
});

describe("protected-resource metadata through the worker", () => {
  it("serves the /mcp document and 404s the bare root", async () => {
    const doc = await call(fullEnv(), "/.well-known/oauth-protected-resource/mcp");
    expect(doc.status).toBe(200);
    expect(((await doc.json()) as { resource: string }).resource).toBe(`${ORIGIN}/mcp`);
    const root = await call(fullEnv(), "/.well-known/oauth-protected-resource");
    await root.text();
    expect(root.status).toBe(404);
  });

  it("keeps the named sign-in 503 when CHARTER_GATEWAY_URL is invalid (provider construction never pre-empts it)", async () => {
    const env = fullEnv({ CHARTER_GATEWAY_URL: "not a url" });
    const authorize = await call(env, "/authorize?response_type=code&client_id=x");
    const text = await authorize.text();
    expect(authorize.status).toBe(503);
    expect(text).toContain("CHARTER_GATEWAY_URL");
  });
});

describe("OAuth end to end (authorize → token → /mcp → refresh)", () => {
  type Tokens = { access_token: string; refresh_token: string };

  /**
   * Full sign-in. By default sends RFC 8707 `resource` at /authorize and
   * /token as Claude does; `{ resource: null }` signs in as a client that
   * never sends one.
   */
  async function signIn(
    env: Env,
    opts: { resource?: string | null } = {},
  ): Promise<{ clientId: string; tokens: Tokens }> {
    const resource = opts.resource === undefined ? RESOURCE : opts.resource;
    const withResource: Record<string, string> = resource ? { resource } : {};
    const started = await startFlow(env, { code_challenge: await s256(VERIFIER), ...withResource });
    const state = await consent(env, started.state, started.cookie);
    stubGoogleSignIn("someone@example.com");
    const cb = await call(env, `/callback?state=${encodeURIComponent(state)}&code=good`, {
      headers: { Cookie: started.cookie },
    });
    await cb.text();
    expect(cb.status).toBe(302);
    const code = new URL(cb.headers.get("Location")!).searchParams.get("code")!;
    const res = await call(env, "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: started.clientId,
        code_verifier: VERIFIER,
        ...withResource,
      }).toString(),
    });
    const body = await res.text();
    expect(res.status, body).toBe(200);
    const tokens = JSON.parse(body) as Tokens;
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    return { clientId: started.clientId, tokens };
  }

  /** POST an MCP initialize; returns status and the consumed body. */
  async function mcpInitialize(env: Env, accessToken: string): Promise<{ status: number; body: string }> {
    const res = await call(env, "/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } },
      }),
    });
    return { status: res.status, body: await res.text() };
  }

  function refresh(env: Env, clientId: string, refreshToken: string, resource: string | null): Promise<Response> {
    const params: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    };
    if (resource) params.resource = resource;
    return call(env, "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
  }

  it("issues a token that /mcp accepts", async () => {
    const env = fullEnv();
    const { tokens } = await signIn(env);
    const res = await mcpInitialize(env, tokens.access_token);
    expect(res.status, res.body).toBe(200);
    expect(res.body).toContain('"result"');
  });

  it("refreshes for the same resource, and the new token works on /mcp", async () => {
    const env = fullEnv();
    const { clientId, tokens } = await signIn(env);
    const res = await refresh(env, clientId, tokens.refresh_token, RESOURCE);
    const body = await res.text();
    expect(res.status, body).toBe(200);
    const next = JSON.parse(body) as Tokens;
    expect((await mcpInitialize(env, next.access_token)).status).toBe(200);
  });

  it("serves a client that never sends `resource`, through sign-in and refresh", async () => {
    const env = fullEnv();
    const { clientId, tokens } = await signIn(env, { resource: null });
    expect((await mcpInitialize(env, tokens.access_token)).status).toBe(200);
    const res = await refresh(env, clientId, tokens.refresh_token, null);
    const body = await res.text();
    expect(res.status, body).toBe(200);
    expect((await mcpInitialize(env, (JSON.parse(body) as Tokens).access_token)).status).toBe(200);
  });

  it("refuses a refresh for the bare origin: grants are bound to /mcp exactly", async () => {
    const env = fullEnv();
    const { clientId, tokens } = await signIn(env);
    const res = await refresh(env, clientId, tokens.refresh_token, ORIGIN);
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(["invalid_target", "invalid_grant"]).toContain(error);
  });

  it("rejects a bearer token it never issued", async () => {
    const res = await mcpInitialize(fullEnv(), "not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("answers 503, never 4xx, on provider routes while CHARTER_GATEWAY_URL is unusable, and the grant survives", async () => {
    const env = fullEnv();
    const { clientId, tokens } = await signIn(env);
    // Same KV, broken config: the provider must not run at all, or the refresh
    // would 400 (clients then drop their tokens) or rebind the grant.
    const broken = { ...env, CHARTER_GATEWAY_URL: "not a url" };

    const refreshed = await refresh(broken, clientId, tokens.refresh_token, RESOURCE);
    expect(refreshed.status).toBe(503);
    expect(((await refreshed.json()) as { error: string }).error).toBe("temporarily_unavailable");

    const mcp = await mcpInitialize(broken, tokens.access_token);
    expect(mcp.status).toBe(503);
    expect(JSON.parse(mcp.body).error).toBe("temporarily_unavailable");

    // Config fixed: the same refresh token still works and the new token is accepted.
    const fixed = await refresh(env, clientId, tokens.refresh_token, RESOURCE);
    const body = await fixed.text();
    expect(fixed.status, body).toBe(200);
    expect((await mcpInitialize(env, (JSON.parse(body) as Tokens).access_token)).status).toBe(200);
  });

  it("503s every provider-owned path when unusable, but not look-alikes", async () => {
    const env = fullEnv({ CHARTER_GATEWAY_URL: "" });
    for (const [path, method] of [
      ["/token", "POST"],
      ["/register", "POST"],
      ["/mcp", "POST"],
      ["/mcp/sub", "POST"],
      ["/.well-known/oauth-authorization-server", "GET"],
    ] as const) {
      const res = await call(env, path, { method });
      await res.text();
      expect(res.status, path).toBe(503);
    }
    const lookalike = await call(env, "/mcpfoo", { method: "POST" });
    await lookalike.text();
    expect(lookalike.status).toBe(404);
  });

  it("does not let an origin that makes the provider throw take down /call or the home page", async () => {
    const env = fullEnv({ CHARTER_GATEWAY_URL: "https://gw{x}.example.com" });
    const home = await call(env, "/");
    await home.text();
    expect(home.status).toBe(200);
    const token = await call(env, "/token", { method: "POST" });
    await token.text();
    expect(token.status).toBe(503);
  });

  it("follows the configured origin when it changes between requests", async () => {
    const resourcesOf = async (env: Env): Promise<string[]> =>
      (
        (await (
          await call(env, "/.well-known/oauth-authorization-server")
        ).json()) as { protected_resources: string[] }
      ).protected_resources;
    expect(await resourcesOf(fullEnv())).toEqual([RESOURCE]);
    expect(
      await resourcesOf(fullEnv({ CHARTER_GATEWAY_URL: "https://other.example.com" })),
    ).toEqual(["https://other.example.com/mcp"]);
  });
});
