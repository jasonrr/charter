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
import { createMcpHandler } from "agents/mcp";
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
import {
  clearStateCookie,
  importStateKey,
  mintFlow,
  openState,
  sealState,
  setStateCookie,
  type Flow,
} from "./state.js";

export type Env = {
  OAUTH_KV: KVNamespace;
  CHARTER_CORE_URL: string;
  CHARTER_ALLOWED_DOMAIN: string;
  GOOGLE_CLIENT_ID: string;
  /** wrangler secret put CHARTER_CREDENTIAL */
  CHARTER_CREDENTIAL: string;
  /** wrangler secret put GOOGLE_CLIENT_SECRET */
  GOOGLE_CLIENT_SECRET: string;
  /** wrangler secret put OAUTH_STATE_SECRET — HMAC key for the sign-in state (state.ts). */
  OAUTH_STATE_SECRET: string;
  /** Not a wrangler binding — OAuthProvider injects this before calling a handler. */
  OAUTH_PROVIDER: OAuthHelpers;
};

/**
 * Config the sign-in routes cannot run without.
 *
 * Every one of these is `string` on `Env` but `undefined` at runtime when it is
 * unset, and each fails somewhere unhelpful and far away — an empty
 * GOOGLE_CLIENT_ID reaches the user as Google's own "Could not determine client
 * ID from request", and a missing OAUTH_STATE_SECRET would otherwise be a
 * silent downgrade to unsigned state. Name them at the door instead.
 */
function missingConfig(env: Env): string[] {
  return (
    [
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "OAUTH_STATE_SECRET",
      "CHARTER_ALLOWED_DOMAIN",
    ] as const
  ).filter((name) => !env[name]);
}

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
    // `Env` types this as `string`, but an unset wrangler secret is
    // `undefined` at runtime. Without the fallback, a misconfigured deploy
    // sends google.ts a literal `client_secret=undefined` upstream instead of
    // failing legibly.
    clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
    redirectUri: new URL("/callback", gatewayUrl).toString(),
    allowedDomain: env.CHARTER_ALLOWED_DOMAIN,
  };
}

function coreConfig(env: Env): CoreConfig {
  return {
    url: env.CHARTER_CORE_URL,
    // Same reasoning as clientSecret above: core.ts's scrub() calls
    // .split(":") on this unconditionally, and an unset CHARTER_CREDENTIAL is
    // `undefined` despite the `string` type — the fallback turns that into a
    // clean 401 from core instead of a raw TypeError surfaced to the model.
    credential: env.CHARTER_CREDENTIAL ?? "",
  };
}

// --- the MCP API handler -----------------------------------------------------

/**
 * The actor token is resolved once per request by the caller and handed in,
 * rather than re-derived per tool call. A dead Google refresh token has to
 * become a 401 so the client re-runs OAuth, and a tool handler cannot produce
 * one — by the time it runs, the MCP layer has already committed to a 200
 * JSON-RPC envelope. Resolving it at the request boundary is what makes that
 * status code reachable.
 */
function buildServer(env: Env, actorToken: string): McpServer {
  // A fresh server per request: the SDK (>=1.26.0) refuses to reconnect one.
  const server = new McpServer({ name: "charter", version: "0.1.0" });

  const run = (
    toolName: string,
    args: { verb: string; args?: Record<string, unknown> },
  ) => handleTool(fetch, coreConfig(env), toolName, args, actorToken);

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

/**
 * Tell the client its charter session is over so it re-runs OAuth.
 *
 * Without this the gateway's own MCP token stays valid while the Google
 * identity behind it is dead, so the client sees only tool-result text, never a
 * 401, and never re-authorizes — the session is stuck until a human reconnects
 * by hand. The description is a fixed string: upstream Google text has no place
 * in a header, and there is nothing here a client can act on beyond "sign in
 * again".
 */
function unauthorized(): Response {
  return new Response("charter sign-in expired; re-authorize", {
    status: 401,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "WWW-Authenticate":
        'Bearer error="invalid_token", ' +
        'error_description="charter sign-in expired; re-authorize"',
    },
  });
}

/** OAuthProvider attaches the decrypted grant props here before routing to us. */
type PropsContext = ExecutionContext & { props?: unknown };

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const props = (ctx as PropsContext).props as Props | undefined;
    if (!props?.identity) return unauthorized();

    // Re-mint the Google ID token if it is at or near expiry (§4.6), here at
    // the request boundary rather than inside a tool, so a dead refresh token
    // can still become a 401 (see buildServer). freshIdToken is a no-op with no
    // network call until the token is actually near expiry.
    //
    // ponytail: freshIdToken returns a rotated identity and we discard it, which
    // costs two things. The cheap one: past the one-hour mark every request pays
    // a Google round-trip, because nothing remembers the newer token. The sharp
    // one: google.ts deliberately adopts a rotated refresh_token, and dropping
    // it means that if Google ever rotates ours, the stored one is dead and the
    // session ends at "sign in again" with no way to recover in place. Google
    // rarely rotates for web clients, which is the only reason this is a note
    // and not a fix. Writing the identity back needs OAuthProvider's
    // tokenExchangeCallback.
    let actorToken: string;
    try {
      ({ idToken: actorToken } = await freshIdToken(
        fetch,
        googleConfig(env, request.url),
        props.identity,
        Math.floor(Date.now() / 1000),
      ));
    } catch {
      // Cause deliberately dropped: google.ts's message is for a human reading a
      // browser, not for a header, and the client's only move is to re-authorize.
      return unauthorized();
    }

    return createMcpHandler(buildServer(env, actorToken), { route: "/mcp" })(
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
    const isAuthRoute =
      url.pathname === "/authorize" || url.pathname === "/callback";

    // Fail closed and fail named. In particular there is no unsigned-state
    // fallback: without OAUTH_STATE_SECRET the sign-in routes do not run.
    const missing = isAuthRoute ? missingConfig(env) : [];
    if (missing.length > 0) {
      return browserError(
        "charter-gateway is not fully configured; sign-in is disabled.\n\n" +
          `Unset: ${missing.join(", ")}\n\n` +
          "See docs/deployment/gateway.md — vars go in wrangler.jsonc, " +
          "secrets are set with `wrangler secret put`.",
        503,
      );
    }

    if (url.pathname === "/authorize") {
      let state: string;
      let flow: Flow;
      try {
        // @cloudflare/workers-oauth-provider parses and redirect-URI-checks the
        // client's request. We sign it and bind it to this browser before
        // handing it to Google — see state.ts for why both halves are needed.
        const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
        flow = mintFlow();
        state = await sealState(
          await importStateKey(env.OAUTH_STATE_SECRET),
          authRequest,
          flow,
          Math.floor(Date.now() / 1000),
        );
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
      // Response.redirect() cannot carry Set-Cookie, and the cookie is the
      // half of the CSRF defence a signature cannot provide.
      return new Response(null, {
        status: 302,
        headers: {
          Location: buildAuthorizeUrl(googleConfig(env, request.url), state),
          "Set-Cookie": setStateCookie(flow),
        },
      });
    }

    if (url.pathname === "/callback") {
      // Everything on this path is caller-supplied, so authenticate the state
      // before spending a Google round-trip on it.
      const opened = await openState(
        await importStateKey(env.OAUTH_STATE_SECRET),
        url.searchParams.get("state") ?? "",
        request.headers.get("Cookie"),
        Math.floor(Date.now() / 1000),
      );
      if (!opened.ok) return browserError(opened.reason, 400);
      const oauthReq = opened.authRequest as AuthRequest;

      // Re-check the redirect URI even though the state is now signed, and the
      // signature already rules out an edited one. The reason is freshness, not
      // integrity: parseAuthRequest checked this at /authorize, and a client's
      // registration can be updated or deleted in between — so a state that was
      // honest when we signed it can name a URI that is no longer registered by
      // the time it comes back. completeAuthorization re-checks nothing itself.
      // Cheap to re-run, so re-run it.
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
      // Clear this flow's cookie on the way out: it is spent, and should not be
      // able to authenticate a second state. Any other flow's cookie is left
      // alone — that is the point of the per-flow name.
      return new Response(null, {
        status: 302,
        headers: {
          Location: redirectTo,
          "Set-Cookie": clearStateCookie(opened.flowId),
        },
      });
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
