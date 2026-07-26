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
  TOOL_CALL_DESCRIPTION,
  TOOL_CALL_NAME,
  TOOL_INPUT_SHAPE,
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
    // ponytail: the re-minted identity is not written back to the grant, so a
    // session past the one-hour mark pays a Google round-trip per tool call.
    // Persisting it needs OAuthProvider's tokenExchangeCallback; not worth the
    // moving parts until the extra hop shows up as a problem.
    const { idToken } = await freshIdToken(
      fetch,
      googleConfig(env, gatewayUrl),
      props.identity,
      Math.floor(Date.now() / 1000),
    );
    return handleTool(fetch, coreConfig(env), toolName, args, idToken);
  };

  server.tool(TOOL_READ_NAME, TOOL_READ_DESCRIPTION, TOOL_INPUT_SHAPE, (a) =>
    run(TOOL_READ_NAME, a),
  );
  server.tool(TOOL_CALL_NAME, TOOL_CALL_DESCRIPTION, TOOL_INPUT_SHAPE, (a) =>
    run(TOOL_CALL_NAME, a),
  );
  return server;
}

const apiHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // createMcpHandler reads the grant's props off ctx, which OAuthProvider
    // decrypted and attached before routing here.
    //
    // The cast bridges a version skew, not a shape mismatch: `agents` 0.2.35
    // depends on @modelcontextprotocol/sdk 1.23.0 exactly and gets its own
    // nested copy, while this package builds against 1.29.0. The two McpServer
    // classes are structurally identical for everything used here; TypeScript
    // rejects the assignment only because `Server` declares a private field,
    // which makes the comparison nominal. Everything 1.29's Transport adds over
    // 1.23's is optional, so agents' WorkerTransport still satisfies the server
    // it is handed. Deduping the SDK would remove the cast — see the task-4
    // report before changing either pin.
    const server = buildServer(env, request.url) as unknown as Parameters<
      typeof createMcpHandler
    >[0];
    return createMcpHandler(server, { route: "/mcp" })(request, env, ctx);
  },
};

// --- the sign-in handler (Google federation) ---------------------------------

const authHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize") {
      // @cloudflare/workers-oauth-provider parsed (and redirect-URI-checked) the
      // client's request; carry it as state so /callback can complete the grant
      // it belongs to. Plain JSON, not base64 — URLSearchParams already escapes
      // it, and btoa would throw on any non-Latin-1 character a client puts in
      // its own `state`.
      const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      const state = JSON.stringify(oauthReq);
      return Response.redirect(
        buildAuthorizeUrl(googleConfig(env, request.url), state),
        302,
      );
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? "";
      let identity: GoogleIdentity;
      try {
        identity = await exchangeCode(
          fetch,
          googleConfig(env, request.url),
          code,
        );
      } catch (e) {
        // Safe to show: google.ts redacts the client secret before throwing.
        return new Response((e as Error).message, { status: 403 });
      }
      const oauthReq = JSON.parse(state);
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReq,
        userId: identity.email,
        metadata: { label: identity.email },
        scope: oauthReq.scope,
        props: { identity } satisfies Props,
      });
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
