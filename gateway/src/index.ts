/**
 * charter-gateway: MCP over Streamable HTTP, OAuth in front, charter-core behind.
 *
 * Wiring only. The gateway holds two secrets — core's CF Access service token
 * and the Google client secret — so humans hold neither (§3). It decides
 * nothing, and carries no authority of its own: the caller's Google ID token
 * rides to core as X-Actor-Token with no API key beside it, and core derives
 * scope from grants and writes the audit row (§2.1).
 *
 * Stateless by construction: createMcpHandler in a plain Worker, a fresh
 * McpServer per request. No Durable Object — the gateway keeps no per-session
 * state of its own; the only state is the OAuth grant, which
 * @cloudflare/workers-oauth-provider persists (encrypted) in KV.
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
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
  GOOGLE_ISSUER,
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
import { readResult, RESULT_URI_PREFIX } from "./results.js";
import { escapeHtml } from "./html.js";
import { isAuthRoute } from "./routes.js";
import {
  callbackUri,
  handoffPage,
  isConnectState,
  parseConnectPath,
  parseProviders,
  upstreamAuthorizeUrl,
  type ConnectState,
} from "./connect.js";
import {
  classifyRedirectUri,
  matchesRegisteredRedirectUri,
  parseExtraOrigins,
  screenRedirectUris,
} from "./redirect_uri.js";
import { gatewayOrigin, gatewayUrlProblem } from "./gateway_url.js";
import {
  MCP_PATH,
  protectedResourceMetadata,
  protectedResourceOf,
  resourceMetadataUrl,
} from "./prm.js";
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
  /**
   * The gateway's own canonical origin, e.g. "https://charter.example.com".
   * Used ONLY to decide which redirect URIs a dynamically registered client
   * may claim as "this gateway" (redirect_uri.ts, screenRegistration below) —
   * pinned to configuration rather than read off the request so that a Worker
   * reachable on a route it wasn't meant to answer can't have an
   * attacker-chosen Host whitelisted as the gateway at registration time. A
   * deploy that legitimately answers more than one hostname (see
   * docs/deployment/gateway.md's "register every hostname" note) should add
   * the others to CHARTER_EXTRA_REDIRECT_ORIGINS, same as any other trusted
   * origin.
   */
  CHARTER_GATEWAY_URL: string;
  /** wrangler secret put CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET — the
   * service token for core's tunnel. Unset on a deploy whose core is not behind
   * CF Access. */
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  /**
   * Optional. A charter API key, sent only on a call with no signed-in human
   * (core.ts's authHeaders). Leave it unset for the human-facing deployment:
   * a key present alongside an actor token would override that human's grant,
   * which is what §2.1 forbids.
   */
  CHARTER_API_KEY?: string;
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
  /**
   * Optional JSON map of upstream systems a user can connect for act-as
   * writes, e.g.
   *   {"hs":{"authorize_url":"https://app.hubspot.com/oauth/authorize",
   *          "client_id":"...","scopes":"oauth content",
   *          "verb":"identity.hs.connect"}}
   * Public values only — the client SECRET stays in core, which does the
   * exchange (connect.ts). Unset means /connect/* 404s.
   */
  CHARTER_CONNECT_PROVIDERS?: string;
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
      // Unset, it silently disables redirect-URI screening's whole point; the
      // shapes it can be wrong in *besides* unset are gatewayUrlProblem's job.
      "CHARTER_GATEWAY_URL",
    ] as const
  ).filter((name) => !env[name]);
}

/**
 * The connect routes' own required config — a strict subset of the above.
 *
 * They mint the same signed state, and they build the upstream's redirect_uri
 * out of CHARTER_GATEWAY_URL, but they touch nothing Google. A deployment that
 * only wants connect should not be told to set GOOGLE_CLIENT_SECRET.
 */
function missingConnectConfig(env: Env): string[] {
  return (["OAUTH_STATE_SECRET", "CHARTER_GATEWAY_URL"] as const).filter(
    (name) => !env[name],
  );
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
    // Same reasoning as clientSecret above: these are `undefined` at runtime
    // when unset, and core.ts treats an empty value as "no such header" — a
    // misconfigured deploy gets a clean rejection from CF Access or core rather
    // than a header whose value is the string "undefined".
    cfAccessClientId: env.CF_ACCESS_CLIENT_ID ?? "",
    cfAccessClientSecret: env.CF_ACCESS_CLIENT_SECRET ?? "",
    apiKey: env.CHARTER_API_KEY ?? "",
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
export function buildServer(env: Env, actorToken: string): McpServer {
  // A fresh server per request: the SDK (>=1.26.0) refuses to reconnect one.
  const server = new McpServer({ name: "charter", version: "0.1.0" });

  // Spec 2026-07-28 documents `traceparent` in `_meta` as the OpenTelemetry
  // propagation convention (SEP-414). Reading it here is what lets core's audit
  // row be joined to the caller's own trace; the value is shape-checked in
  // core.ts before it becomes a header, and again in core before it is stored.
  const run = (
    toolName: string,
    args: { verb: string; args?: Record<string, unknown> },
    meta?: Record<string, unknown>,
  ) =>
    handleTool(
      fetch,
      coreConfig(env),
      toolName,
      args,
      actorToken,
      typeof meta?.traceparent === "string" ? meta.traceparent : undefined,
    );

  // Read is registered first, as the proxy's own check expects.
  server.registerTool(
    TOOL_READ_NAME,
    {
      description: TOOL_READ_DESCRIPTION,
      inputSchema: TOOL_INPUT_SHAPE,
      annotations: TOOL_READ_ANNOTATIONS,
    },
    (a, extra) => run(TOOL_READ_NAME, a, extra._meta),
  );
  server.registerTool(
    TOOL_CALL_NAME,
    {
      description: TOOL_CALL_DESCRIPTION,
      inputSchema: TOOL_INPUT_SHAPE,
      annotations: TOOL_CALL_ANNOTATIONS,
    },
    (a, extra) => run(TOOL_CALL_NAME, a, extra._meta),
  );

  // §4.5 resource-link-out: the dereference surface for offloaded results.
  // { list: undefined } = readable, never listed — a result id is one caller's
  // one-off artifact, not a catalog entry. The read re-authorizes through core
  // (result.read is producer-only), carrying this request's actor token; the
  // gateway still decides nothing and stores nothing (§2.1, §2.4).
  server.registerResource(
    "result",
    new ResourceTemplate(`${RESULT_URI_PREFIX}{id}`, { list: undefined }),
    {
      title: "Offloaded verb result",
      description:
        "Full body of a verb result that was too large to inline. Expires; re-run the verb to regenerate.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = String(variables.id ?? "");
      const r = await readResult(fetch, coreConfig(env), id, actorToken);
      if (r.isError) throw new Error(r.text);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: r.text }],
      };
    },
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
function browserError(
  message: string,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...extraHeaders },
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

/**
 * RFC 9207 / SEP-2468: a client MUST validate a *present* `iss` on an
 * authorization response against the issuer it recorded, before redeeming the
 * code. The gateway is a client twice over — of Google at /callback, and of
 * each configured upstream at /connect/<id>/callback.
 *
 * Absent is not a failure. Emitting `iss` is only a SHOULD on the authorization
 * server, so rejecting a response that omits it would break every upstream that
 * has not adopted the parameter — which today is most of them. The defence this
 * adds is against a *wrong* issuer, i.e. a code minted by one authorization
 * server being walked into another's callback.
 *
 * `expected` may be undefined for an upstream with no configured issuer; with
 * nothing recorded there is nothing to validate against, so the check is a
 * no-op rather than a guess.
 */
export function issuerMismatch(
  returned: string | null,
  expected: string | undefined,
): boolean {
  return returned !== null && expected !== undefined && returned !== expected;
}

const authHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Fail closed and fail named. In particular there is no unsigned-state
    // fallback: without OAUTH_STATE_SECRET the sign-in routes do not run.
    const connectRoute = parseConnectPath(url.pathname);
    const missing = isAuthRoute(url.pathname)
      ? missingConfig(env)
      : connectRoute
        ? missingConnectConfig(env)
        : [];
    if (missing.length > 0) {
      return browserError(
        "charter-gateway is not fully configured.\n\n" +
          `Unset: ${missing.join(", ")}\n\n` +
          "See docs/deployment/gateway.md — vars go in wrangler.jsonc, " +
          "secrets are set with `wrangler secret put`.",
        503,
      );
    }

    // Set but wrong is the quieter failure, and the only place it shows up is
    // here, against the origin a request actually arrived on. See gateway_url.ts.
    // Both route families mint state and both derive a URI from the configured
    // origin, so both need the origin check. connectRoute is already computed;
    // re-deriving it through a predicate would only re-run the same regex.
    if (isAuthRoute(url.pathname) || connectRoute) {
      const problem = gatewayUrlProblem(
        env.CHARTER_GATEWAY_URL,
        request.url,
        parseExtraOrigins(env.CHARTER_EXTRA_REDIRECT_ORIGINS),
      );
      if (problem) {
        return browserError(
          `charter-gateway is misconfigured.\n\n${problem}\n\n` +
            "See docs/deployment/gateway.md.",
          503,
        );
      }
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

        // The confused-deputy control, applied where every client passes
        // regardless of how it got its client_id.
        //
        // screenRegistration is not enough on its own any more: it gates
        // /register, and a CIMD client never goes through /register — it names
        // an https URL as its client_id and the provider fetches redirect_uris
        // from whatever document is there. Without this, an attacker hosting a
        // metadata document pointing at their own server gets exactly the
        // attack redirect_uri.ts exists to prevent, having simply skipped the
        // route that screens for it.
        //
        // For a DCR client this is a re-check of what registration already
        // allowed, and cheap — the same freshness argument /callback makes.
        const verdict = classifyRedirectUri(
          authRequest.redirectUri,
          gatewayOrigin(env.CHARTER_GATEWAY_URL) ?? "",
          parseExtraOrigins(env.CHARTER_EXTRA_REDIRECT_ORIGINS),
        );
        if (!verdict.allowed) {
          return browserError(
            "charter will not send an authorization code to this client's " +
              `redirect_uri.\n\nIt ${verdict.reason}.\n\n` +
              "This is the control that stops a code being delivered to " +
              "someone other than you; it is not a misconfiguration you can " +
              "work around from the client.",
            400,
          );
        }

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
          // The signed `state` sits in this page's hidden input. A cache entry
          // on shared or disk storage would keep it readable for the rest of
          // its 10-minute window; the HttpOnly cookie still gates using it,
          // but there's no reason to let it sit in a cache at all.
          "Cache-Control": "no-store",
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
      // Sound, not merely convenient: `authRequest` is typed `unknown` in
      // OpenResult so state.ts stays ignorant of AuthRequest's shape — but the
      // value behind it is exactly what /authorize passed to sealState, JSON
      // round-tripped through the signed state and handed back only after
      // openState's HMAC check above passed. Nobody can produce a payload
      // this function accepts other than by replaying one we ourselves signed,
      // so nothing forged reaches this cast.
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
      // Same semantics as parseAuthRequest's check, not a bare .includes():
      // loopback URIs match with the port ignored (RFC 8252 §7.3). An exact
      // comparison here rejected every native client whose ephemeral port
      // changed since registration — after Google, at the last step.
      if (
        !client ||
        !matchesRegisteredRedirectUri(oauthReq.redirectUri, client.redirectUris)
      ) {
        return browserError("invalid redirect uri", 400);
      }

      // Before the code is spent: this response claims to come from Google, so
      // if it names an issuer at all it has to name Google's.
      if (issuerMismatch(url.searchParams.get("iss"), GOOGLE_ISSUER)) {
        return browserError("invalid issuer", 400);
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
      // The other half of RFC 9207: charter is the authorization server for the
      // MCP client it is answering, so tell that client which issuer this
      // response came from. The value has to be the one the client recorded from
      // our metadata, and @cloudflare/workers-oauth-provider builds that from
      // the request's own origin (`new URL(tokenEndpoint).origin`) — so this
      // derives it the same way rather than from CHARTER_GATEWAY_URL, which
      // would mismatch for a client that discovered us on an extra origin.
      const issued = new URL(redirectTo);
      issued.searchParams.set("iss", url.origin);

      // Clear this flow's cookie on the way out: it is spent, and should not be
      // able to authenticate a second state. Any other flow's cookie is left
      // alone — that is the point of the per-flow name.
      return new Response(null, {
        status: 302,
        headers: {
          Location: issued.toString(),
          "Set-Cookie": clearStateCookie(opened.flow.flowId),
        },
      });
    }

    // Upstream connect (connect.ts): the browser half of act-as. An unknown id
    // 404s — an enumerable "that provider exists but isn't set up here" tells an
    // unauthenticated caller about the deployment's integrations for nothing in
    // return. A *configured but malformed* entry is the opposite case and gets a
    // named 503: the operator wrote that id, so nothing is disclosed by saying
    // which field is wrong, and the alternative is a permanent 404 with nothing
    // to grep (the mistake gateway_url.ts exists to stop repeating).
    if (connectRoute) {
      const table = parseProviders(env.CHARTER_CONNECT_PROVIDERS);
      const provider = table.providers[connectRoute.id];
      if (!provider) {
        const why = table.parseError ?? table.rejected[connectRoute.id];
        if (why) {
          return browserError(
            `charter-gateway is misconfigured; this upstream cannot be connected.\n\n` +
              `CHARTER_CONNECT_PROVIDERS: ${table.parseError ? why : `entry "${connectRoute.id}" is invalid (${why})`}\n\n` +
              "See docs/deployment/gateway.md.",
            503,
          );
        }
        return browserError("not found", 404);
      }
      const redirectUri = callbackUri(env.CHARTER_GATEWAY_URL, connectRoute.id);

      if (!connectRoute.isCallback) {
        const flow = mintFlow();
        // `consented` is left at its default false, and that is load-bearing in
        // the other direction: it is the only thing stopping this state from
        // being replayed at /callback, which requires the flag. Passing true
        // here to mean "the upstream will show its own consent screen" would
        // hand a connect state a sign-in grant.
        const state = await sealState(
          await importStateKey(env.OAUTH_STATE_SECRET),
          { p: connectRoute.id } satisfies ConnectState,
          flow,
          Math.floor(Date.now() / 1000),
        );
        return new Response(null, {
          status: 302,
          headers: {
            Location: upstreamAuthorizeUrl(provider, redirectUri, state),
            "Set-Cookie": setStateCookie(flow),
          },
        });
      }

      // Authenticate the state before reading anything else off this URL.
      const opened = await openState(
        await importStateKey(env.OAUTH_STATE_SECRET),
        url.searchParams.get("state") ?? "",
        request.headers.get("Cookie"),
        Math.floor(Date.now() / 1000),
      );
      if (!opened.ok) return browserError(opened.reason, 400);
      // A state signed for one provider must not be spendable at another's
      // callback: the id decides which authorize URL issued the code, and
      // crossing them would hand provider A's code to the verb that spends
      // provider B's. Signed by us is not the same as meant for here.
      if (!isConnectState(opened.authRequest, connectRoute.id)) {
        return browserError("invalid state", 400);
      }
      // The upstream declining is a normal outcome (the user pressed Cancel),
      // not a gateway fault — say so without echoing an arbitrary query value
      // into the page.
      // Clear the cookie on every terminal branch below, this one included: the
      // flow is over either way, and a nonce left live is one an abandoned tab
      // could still spend.
      const spent = clearStateCookie(opened.flow.flowId);
      if (url.searchParams.get("error")) {
        return browserError(
          "the upstream did not grant access. Nothing was connected; start again when ready.",
          400,
          { "Set-Cookie": spent },
        );
      }
      // Same check as the Google leg, against this provider's configured issuer
      // — skipped when the operator has not set one (see ConnectProvider.issuer).
      if (issuerMismatch(url.searchParams.get("iss"), provider.issuer)) {
        return browserError("invalid issuer", 400, { "Set-Cookie": spent });
      }
      const code = url.searchParams.get("code") ?? "";
      if (!code) {
        return browserError("no authorization code returned", 400, { "Set-Cookie": spent });
      }
      return new Response(handoffPage(provider, code, redirectUri, TOOL_CALL_NAME), {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Set-Cookie": spent,
          // The page carries a live authorization code. Keep it out of shared
          // caches and out of the referrer sent to anything it links to.
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          // Same reasoning as the consent page's: this page's escaping is
          // load-bearing, so a future edit that adds a script should fail loudly
          // rather than silently work. No form here, so no form-action.
          "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
          "X-Frame-Options": "DENY",
        },
      });
    }

    // "/" identifies the deployment to a human who lands on it. Everything
    // else is 404, not a cheerful 200: this handler is the provider's
    // catch-all, so it is what answered `/.well-known/oauth-protected-resource`
    // — an unparseable 200 where a client expected metadata or a 404, which is
    // how the missing PRM endpoint (prm.ts) stayed invisible.
    if (url.pathname === "/") {
      return new Response("charter-gateway", { status: 200 });
    }
    return new Response("not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
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
  // OAuth 2.1 / MCP posture (spec §5): S256 only. With this set the provider
  // rejects `plain` at parseAuthRequest — and a request with no
  // code_challenge_method defaults to plain, so PKCE is effectively required —
  // and advertises only ["S256"] in the authorization-server metadata, so
  // clients are told the same thing they are handed. Needs provider >=0.8;
  // before that there was no hook, which is why the runbook documented this
  // as offered-not-required.
  allowPlainPKCE: false,
  // Client ID Metadata Documents: a client_id that is an https URL resolves to
  // a JSON document describing the client, instead of the client POSTing itself
  // to /register. Spec 2026-07-28 deprecates Dynamic Client Registration in
  // favour of this; /register stays for authorization servers and clients that
  // have not moved.
  //
  // Enabling it opens a second way in that screenRegistration cannot see — a
  // CIMD client never registers, so its redirect_uris arrive from a document
  // the gateway merely fetched. The redirect-URI policy is therefore enforced
  // again at /authorize, where both kinds of client meet. Do not remove that
  // check while this is true.
  clientIdMetadataDocumentEnabled: true,
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

  // Pinned to CHARTER_GATEWAY_URL, never the incoming request's Host: a Worker
  // can receive a request for a Host it was never meant to answer (see the
  // field comment on Env), and reading the origin off `request.url` here let a
  // registration made under an off-canonical Host get that host whitelisted as
  // "the gateway" permanently — nothing at /callback re-derives or re-checks
  // it, so this acceptance is the only gate that ever runs.
  const origin = gatewayOrigin(env.CHARTER_GATEWAY_URL);
  if (!origin) {
    return oauthError(
      "server_error",
      "charter-gateway is not configured with a valid CHARTER_GATEWAY_URL; " +
        "registration is disabled.",
      500,
    );
  }

  const { accepted, rejected } = screenRedirectUris(
    requested,
    origin,
    parseExtraOrigins(env.CHARTER_EXTRA_REDIRECT_ORIGINS),
  );

  if (accepted.length === 0) {
    return oauthError(
      "invalid_redirect_uri",
      "charter only registers clients whose redirect_uris are loopback " +
        "addresses (http://localhost, http://127.0.0.1, http://[::1]) or https " +
        `URIs on ${origin}. A redirect URI on any other ` +
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

/**
 * Public, unauthenticated metadata, so any origin may read it — matching what
 * the provider already does for /.well-known/oauth-authorization-server.
 */
function metadataResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Make a 401 from the MCP endpoint carry RFC 9728's `resource_metadata` —
 * built from the *configured* origin, and only that.
 *
 * This is discovery mechanism 1 (prm.ts). The well-known paths alone would
 * satisfy the spec, but the header saves a client two probe round-trips and is
 * the mechanism clients reach for first. Applied out here rather than inside
 * `unauthorized()` because most 401s on /mcp come from the OAuth provider's own
 * token check, never reaching our handler — a header on only half of them
 * would be worse than none.
 *
 * The provider (>=0.8) decorates its own 401s too, but derives the URL from
 * the request's origin — steerable by whoever set the Host, the exact thing
 * prm.ts pins to CHARTER_GATEWAY_URL. So any resource_metadata already on the
 * response is stripped and replaced with the configured one; with no valid
 * configured origin it is stripped and nothing is published.
 */
function withResourceMetadata(res: Response, origin: string | null): Response {
  const headers = new Headers(res.headers);
  const existing = headers.get("WWW-Authenticate");
  const base = existing
    ?.replace(/,\s*resource_metadata="[^"]*"/, "")
    .replace(/resource_metadata="[^"]*",?\s*/, "")
    .trim();
  if (origin) {
    const param = `resource_metadata="${resourceMetadataUrl(origin)}"`;
    headers.set(
      "WWW-Authenticate",
      base && base !== "Bearer" ? `${base}, ${param}` : `Bearer ${param}`,
    );
  } else if (base) {
    headers.set("WWW-Authenticate", base);
  } else if (existing) {
    headers.delete("WWW-Authenticate");
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = gatewayOrigin(env.CHARTER_GATEWAY_URL);

    // RFC 9728 protected-resource metadata (prm.ts). Served ahead of the
    // provider because it describes the MCP endpoint rather than the sign-in
    // flow, and because an unconfigured origin must not be published as fact.
    const resourcePath = protectedResourceOf(url.pathname);
    if (resourcePath !== null) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Max-Age": "86400",
          },
        });
      }
      if (!origin) {
        return metadataResponse(
          {
            error: "server_error",
            error_description:
              "charter-gateway is not configured with a valid " +
              "CHARTER_GATEWAY_URL, so it cannot state its own resource identity.",
          },
          500,
        );
      }
      return metadataResponse(protectedResourceMetadata(origin, resourcePath));
    }

    if (request.method === "POST" && url.pathname === "/register") {
      const screened = await screenRegistration(request, env, ctx);
      if (screened) return screened;
    }

    const res = await provider.fetch(request, env, ctx);
    if (res.status === 401 && url.pathname === MCP_PATH) {
      return withResourceMetadata(res, origin);
    }
    return res;
  },
};
