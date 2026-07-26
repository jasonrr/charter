/**
 * charter-gateway: MCP over Streamable HTTP, OAuth in front, charter-core behind.
 *
 * Wiring only. The gateway holds two secrets — the core credential and the
 * Google client secret — so humans hold neither (§3). It decides nothing: the
 * caller's Google ID token rides to core as X-Actor-Token, and core derives
 * scope from grants and writes the audit row (§2.1).
 *
 * Stateless by construction: createMcpHandler in a plain Worker, a fresh
 * McpServer per request. No Durable Object — the gateway keeps no per-session
 * state of its own; the only state is the OAuth grant, which
 * @cloudflare/workers-oauth-provider persists (encrypted) in KV.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp";
import OAuthProvider, {
  type AuthRequest,
  type OAuthHelpers,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";

import { type CoreConfig } from "./core.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  freshIdToken,
  type GoogleConfig,
  type GoogleIdentity,
} from "./google.js";
import {
  handleTool,
  TOOL_CALL_ANNOTATIONS,
  TOOL_CALL_DESCRIPTION,
  TOOL_CALL_NAME,
  TOOL_INPUT_SHAPE,
  TOOL_READ_ANNOTATIONS,
  TOOL_READ_DESCRIPTION,
  TOOL_READ_NAME,
} from "./tools.js";

export type Env = {
  OAUTH_KV: KVNamespace;
  CHARTER_CORE_URL: string;
  CHARTER_ALLOWED_DOMAIN: string;
  GOOGLE_CLIENT_ID: string;
  /** wrangler secret put CHARTER_CREDENTIAL */
  CHARTER_CREDENTIAL: string;
  /** wrangler secret put GOOGLE_CLIENT_SECRET */
  GOOGLE_CLIENT_SECRET: string;
  /** Not a wrangler binding — OAuthProvider injects this before calling a handler. */
  OAUTH_PROVIDER: OAuthHelpers;
};

/** What we persist per grant. @cloudflare/workers-oauth-provider encrypts this at rest. */
type Props = { identity: GoogleIdentity };

/**
 * Build the Google client config for one request.
 *
 * `gatewayUrl` must be the URL of the request the GATEWAY is serving, because
 * the redirect URI it derives is the gateway's own /callback — the address
 * registered with Google. It is never core's URL: core is a different origin
 * that Google has never heard of, and pointing at it would only look correct
 * for as long as the caller happened not to send a redirect URI upstream.
 */
function googleConfig(env: Env, gatewayUrl: string): GoogleConfig {
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: new URL("/callback", gatewayUrl).toString(),
    allowedDomain: env.CHARTER_ALLOWED_DOMAIN,
  };
}

function coreConfig(env: Env): CoreConfig {
  return { url: env.CHARTER_CORE_URL, credential: env.CHARTER_CREDENTIAL };
}

// --- the MCP API handler -----------------------------------------------------

/**
 * `gatewayUrl` is threaded in rather than read from a global so that every
 * Google call on every path derives its redirect URI from the same place: the
 * request this Worker is answering.
 */
function buildServer(env: Env, gatewayUrl: string): McpServer {
  // A fresh server per request: the SDK (>=1.26.0) refuses to reconnect one.
  const server = new McpServer({ name: "charter", version: "0.1.0" });

  const run = async (
    toolName: string,
    args: { verb: string; args?: Record<string, unknown> },
  ) => {
    const auth = getMcpAuthContext();
    const props = auth?.props as Props | undefined;
    if (!props?.identity) {
      return {
        content: [{ type: "text" as const, text: "not signed in to charter" }],
        isError: true,
      };
    }
    // Re-mint the Google ID token if it is at or near expiry (§4.6). The
    // refresh_token grant sends no redirect_uri, so this path never uses the
    // one in the config — it just must not carry a wrong one.
    // ponytail: freshIdToken returns a rotated identity and we discard it, which
    // costs two things. The cheap one: past the one-hour mark every tool call
    // pays a Google round-trip, because nothing remembers the newer token. The
    // sharp one: google.ts deliberately adopts a rotated refresh_token, and
    // dropping it means that if Google ever rotates ours, the stored one is dead
    // and the session ends at "sign in again" with no way to recover in place.
    // Google rarely rotates for web clients, which is the only reason this is a
    // note and not a fix. Writing the identity back needs OAuthProvider's
    // tokenExchangeCallback.
    const { idToken } = await freshIdToken(
      fetch,
      googleConfig(env, gatewayUrl),
      props.identity,
      Math.floor(Date.now() / 1000),
    );
    return handleTool(fetch, coreConfig(env), toolName, args, idToken);
  };

  // Read is registered first, as the proxy's own check expects.
  server.registerTool(
    TOOL_READ_NAME,
    {
      description: TOOL_READ_DESCRIPTION,
      inputSchema: TOOL_INPUT_SHAPE,
      annotations: TOOL_READ_ANNOTATIONS,
    },
    (a) => run(TOOL_READ_NAME, a),
  );
  server.registerTool(
    TOOL_CALL_NAME,
    {
      description: TOOL_CALL_DESCRIPTION,
      inputSchema: TOOL_INPUT_SHAPE,
      annotations: TOOL_CALL_ANNOTATIONS,
    },
    (a) => run(TOOL_CALL_NAME, a),
  );
  return server;
}

const apiHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // createMcpHandler reads the grant's props off ctx, which OAuthProvider
    // decrypted and attached before routing here.
    return createMcpHandler(buildServer(env, request.url), { route: "/mcp" })(
      request,
      env,
      ctx,
    );
  },
};

// --- the sign-in handler (Google federation) ---------------------------------

/**
 * An error bound for a human's browser.
 *
 * Always text/plain, never HTML: these routes render caller-influenced strings
 * in a browser, and a plain-text content type keeps that from ever being a
 * script sink no matter what a future upstream message contains.
 */
function browserError(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

const authHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize") {
      let state: string;
      try {
        // @cloudflare/workers-oauth-provider parses and redirect-URI-checks the
        // client's request; carry it as state so /callback can complete the
        // grant it belongs to. Plain JSON, not base64 — URLSearchParams already
        // escapes it, and btoa would throw on any non-Latin-1 character a client
        // puts in its own `state`.
        state = JSON.stringify(await env.OAUTH_PROVIDER.parseAuthRequest(request));
      } catch (e) {
        // parseAuthRequest throws on an unregistered redirect URI, which is the
        // first thing an operator gets wrong. An unhandled throw here is a bare
        // 500 with nothing to act on, so name the likely cause. Its messages are
        // fixed library strings — no secrets, no caller input.
        return browserError(
          "charter could not start sign-in for this client.\n\n" +
            "The usual cause is that the client's redirect_uri is not " +
            "registered with charter, or does not match the registered one " +
            "exactly (they are compared byte for byte).\n\n" +
            `(${(e as Error).message})`,
          400,
        );
      }
      return Response.redirect(
        buildAuthorizeUrl(googleConfig(env, request.url), state),
        302,
      );
    }

    if (url.pathname === "/callback") {
      // Everything on this path is caller-supplied, so validate the state
      // before spending a Google round-trip on it.
      let oauthReq: AuthRequest;
      try {
        const parsed: unknown = JSON.parse(url.searchParams.get("state") ?? "");
        // `null` — and any other non-object — parses without throwing, so reject
        // it here. Otherwise reading .clientId below is an uncaught 500, the
        // same defect this guard exists to close.
        if (!parsed || typeof parsed !== "object") throw new Error("not an object");
        oauthReq = parsed as AuthRequest;
      } catch {
        return browserError("invalid state", 400);
      }

      // parseAuthRequest already checked this redirect URI against the client's
      // registered set — but at /authorize, and the check does not survive the
      // trip through `state`. The state is unsigned and completeAuthorization
      // re-checks nothing, so without this a crafted state sends an
      // authorization code to an address of the caller's choosing: an open
      // redirect in an authorization server. Cheap to re-run, so re-run it.
      let client: Awaited<ReturnType<OAuthHelpers["lookupClient"]>>;
      try {
        client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
      } catch {
        // KV rejects oversized keys, so a forged clientId throws rather than
        // missing. Swallow the cause: KV errors can echo the key they were
        // given, and these keys are derived from grant material.
        return browserError("invalid state", 400);
      }
      if (!client?.redirectUris.includes(oauthReq.redirectUri)) {
        return browserError("invalid redirect uri", 400);
      }

      const code = url.searchParams.get("code") ?? "";
      let identity: GoogleIdentity;
      try {
        identity = await exchangeCode(
          fetch,
          googleConfig(env, request.url),
          code,
        );
      } catch (e) {
        // Safe to show: google.ts redacts the client secret before throwing.
        return browserError((e as Error).message, 403);
      }
      let redirectTo: string;
      try {
        ({ redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: oauthReq,
          userId: identity.email,
          metadata: { label: identity.email },
          scope: oauthReq.scope,
          props: { identity } satisfies Props,
        }));
      } catch {
        // Writes the grant to KV and builds the redirect from the state's own
        // fields, so it can throw on a KV failure or a malformed-but-registered
        // request. Swallow the cause for the same reason as lookupClient above.
        return browserError(
          "charter could not finish sign-in. Start again from your client.",
          400,
        );
      }
      return Response.redirect(redirectTo, 302);
    }

    return new Response("charter-gateway", { status: 200 });
  },
};

// OAuthProvider types both handler slots as `ExportedHandler` with the env
// fixed to `unknown` rather than leaving it generic, so no handler that names
// its own Env is assignable. The casts buy back the Env typing above; the
// provider passes the Worker's real env through untouched.
export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: apiHandler as unknown as OAuthProviderOptions["apiHandler"],
  defaultHandler:
    authHandler as unknown as OAuthProviderOptions["defaultHandler"],
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
