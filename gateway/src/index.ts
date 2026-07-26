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
import { escapeHtml } from "./html.js";
import {
  parseExtraOrigins,
  screenRedirectUris,
} from "./redirect_uri.js";
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
  /**
   * Optional, comma-separated. Extra https origins a registered client may use
   * as a redirect URI, beyond loopback and the gateway itself. Defaults to
   * closed; see redirect_uri.ts for why the default is narrow.
   */
  CHARTER_EXTRA_REDIRECT_ORIGINS?: string;
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

/**
 * The consent interstitial.
 *
 * Deliberately shows the redirect URI's **origin** and nothing else
 * identifying: `client_name` is supplied at registration by whoever registers,
 * is never verified, and is therefore the field an attacker would use to look
 * like charter. The origin is where the code will actually be delivered.
 *
 * Every interpolation is escaped — this is the only HTML the gateway emits, and
 * the origin on it comes from a client anyone can register.
 */
function consentPage(redirectOrigin: string, state: string): string {
  const origin = escapeHtml(redirectOrigin);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to charter</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1.25rem; }
  .origin { font: 600 1.05rem/1.4 ui-monospace, monospace; word-break: break-all;
            background: #f4f4f5; border: 1px solid #d4d4d8; border-radius: 6px; padding: .75rem 1rem; }
  .warn { color: #7f1d1d; background: #fef2f2; border: 1px solid #fecaca;
          border-radius: 6px; padding: .75rem 1rem; }
  button { font: inherit; padding: .6rem 1.25rem; border-radius: 6px; border: 0;
           background: #1d4ed8; color: #fff; cursor: pointer; }
  @media (prefers-color-scheme: dark) {
    body { background: #18181b; color: #e4e4e7; }
    .origin { background: #27272a; border-color: #3f3f46; }
    .warn { color: #fecaca; background: #300f0f; border-color: #7f1d1d; }
  }
</style></head><body>
<h1>Connect an app to charter?</h1>
<p>After you sign in with Google, charter will send this app an authorization
code. The code will go to:</p>
<p class="origin">${origin}</p>
<p class="warn"><strong>Only continue if you started this yourself</strong> from
your own MCP client. If you reached this page from a link someone sent you, the
address above may belong to them — continuing would let them act as you in
charter.</p>
<form method="POST" action="/authorize/continue">
  <input type="hidden" name="state" value="${escapeHtml(state)}">
  <button type="submit">Continue to Google</button>
</form>
</body></html>`;
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
      let redirectOrigin: string;
      try {
        // @cloudflare/workers-oauth-provider parses and redirect-URI-checks the
        // client's request. We sign it and bind it to this browser before
        // handing it to Google — see state.ts for why both halves are needed.
        const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
        // The origin, not client_name: the name is whatever the registrant
        // typed and is never verified, so it is the one field an attacker would
        // use to look legitimate. The origin is where the authorization code
        // will actually be sent, which is the thing they cannot fake.
        redirectOrigin = new URL(authRequest.redirectUri).origin;
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
      // Ask before forwarding to Google. The MCP spec's authorization Security
      // Considerations require it for exactly this architecture — one static
      // upstream client id, open registration, forwarding to a third-party
      // authorization server:
      //
      //   "MCP proxy servers using static client IDs MUST obtain user consent
      //    for each dynamically registered client before forwarding to third-
      //    party authorization servers (which may require additional consent)."
      //
      // The cookie rides along here, not on the eventual redirect to Google,
      // because Response.redirect() cannot carry Set-Cookie anyway and the
      // consent POST needs it to prove the same browser is still driving.
      return new Response(consentPage(redirectOrigin, state), {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Set-Cookie": setStateCookie(flow),
          // Nothing on this page loads or runs anything; say so, so a future
          // edit that adds a script fails loudly instead of silently working.
          // frame-ancestors is the clickjacking control: a framed "Continue"
          // posts cross-site and SameSite=Lax already withholds the cookie, but
          // on the one page whose whole job is informed consent the protection
          // should be stated outright, not left resting on a cookie attribute.
          "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; " +
            "frame-ancestors 'none'",
          // For anything still reading the older header.
          "X-Frame-Options": "DENY",
          "Referrer-Policy": "no-referrer",
        },
      });
    }

    // The consent click. Same signed state, same cookie — no second mechanism.
    if (url.pathname === "/authorize/continue" && request.method === "POST") {
      let submitted = "";
      try {
        submitted = String((await request.formData()).get("state") ?? "");
      } catch {
        return browserError("invalid consent submission", 400);
      }
      const opened = await openState(
        await importStateKey(env.OAUTH_STATE_SECRET),
        submitted,
        request.headers.get("Cookie"),
        Math.floor(Date.now() / 1000),
      );
      if (!opened.ok) return browserError(opened.reason, 400);

      // Re-seal with the consent recorded, so /callback can require it instead
      // of assuming it. Same flow, so the cookie still matches; a fresh
      // issued-at, because the Google leg has a human typing a password in it
      // and should get its own full TTL rather than the remainder of this one.
      const consentedState = await sealState(
        await importStateKey(env.OAUTH_STATE_SECRET),
        opened.authRequest,
        opened.flow,
        Math.floor(Date.now() / 1000),
        true,
      );

      // Deliberately NO Set-Cookie here, and that omission is load-bearing.
      //
      // This route will happily re-seal an already-consented state, so `t`
      // alone could be refreshed in a loop and never expire. What actually
      // bounds a sign-in is the cookie's Max-Age, written once at /authorize
      // and never extended — when it lapses, openState fails and no further
      // re-seal is possible. Total ceiling is roughly two TTLs (~20 min),
      // drivable only by the browser already holding the cookie.
      //
      // Refreshing the cookie here — an obvious-looking kindness for a user who
      // is slow on the consent screen — silently removes that cap, with nothing
      // failing to tell you.
      return new Response(null, {
        status: 302,
        headers: {
          Location: buildAuthorizeUrl(
            googleConfig(env, request.url),
            consentedState,
          ),
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

      // Require the consent flag rather than trusting that the screen was
      // unavoidable. It is in practice — the state is disclosed only inside the
      // consent page body, same-origin with no JS and no referrer, and the
      // cookie is HttpOnly — but "in practice" is a property of today's code.
      // This makes it a rule /callback enforces.
      if (!opened.consented) {
        return browserError(
          "this sign-in was not confirmed. Start again from your client.",
          400,
        );
      }
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
          "Set-Cookie": clearStateCookie(opened.flow.flowId),
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
const provider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: apiHandler as unknown as OAuthProviderOptions["apiHandler"],
  defaultHandler:
    authHandler as unknown as OAuthProviderOptions["defaultHandler"],
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

function oauthError(error: string, description: string, status: number): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Screen dynamic client registration before the provider ever sees it.
 *
 * The provider accepts any `redirect_uris` a caller sends, which is what made
 * the confused-deputy attack possible: register a client pointing at your own
 * server, phish a victim through a real Google consent, collect their code.
 * Constraining the URI is the control that *prevents* that; the consent screen
 * only warns about it. See redirect_uri.ts.
 */
async function screenRegistration(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  let body: unknown;
  try {
    // Clone so the provider still gets an unread body to parse itself.
    body = await request.clone().json();
  } catch {
    return null; // not JSON — let the provider produce its own error
  }
  if (!body || typeof body !== "object") return null;

  const requested = (body as { redirect_uris?: unknown }).redirect_uris;
  if (requested === undefined) return null; // the provider will reject it

  const { accepted, rejected } = screenRedirectUris(
    requested,
    new URL(request.url).origin,
    parseExtraOrigins(env.CHARTER_EXTRA_REDIRECT_ORIGINS),
  );

  if (accepted.length === 0) {
    return oauthError(
      "invalid_redirect_uri",
      "charter only registers clients whose redirect_uris are loopback " +
        "addresses (http://localhost, http://127.0.0.1, http://[::1]) or https " +
        `URIs on ${new URL(request.url).origin}. A redirect URI on any other ` +
        "host could deliver a signed-in user's authorization code to someone " +
        "who is not that user. Rejected: " +
        rejected.map((r) => `${r.uri} (${r.reason})`).join("; "),
      400,
    );
  }

  if (rejected.length === 0) return null; // nothing to change

  // Register the acceptable subset rather than failing the whole call: real
  // clients send mixed arrays (VS Code registers loopback *and* vscode.dev in
  // one request), and refusing outright would lock out a client whose primary
  // loopback flow is fine. RFC 7591 has the response echo what was registered.
  return provider.fetch(
    new Request(request, {
      body: JSON.stringify({ ...(body as object), redirect_uris: accepted }),
    }),
    env,
    ctx,
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (
      request.method === "POST" &&
      new URL(request.url).pathname === "/register"
    ) {
      const screened = await screenRegistration(request, env, ctx);
      if (screened) return screened;
    }
    return provider.fetch(request, env, ctx);
  },
};
