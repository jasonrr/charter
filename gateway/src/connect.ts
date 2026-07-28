/**
 * Upstream connect: the browser half of acting as the user in someone else's
 * system.
 *
 * Charter signs a human in (google.ts) and core knows who they are. Separately,
 * a verb may need to act AS that human in an upstream system — draft in their
 * name, publish under their account — which needs a grant from that system,
 * per user. Getting one means a browser round trip, and a pack running inside
 * core has no browser. This module is the piece only a gateway can provide.
 *
 * What it deliberately does NOT do: the token exchange. The upstream client
 * SECRET never reaches the gateway. It stays in core, where the owning pack
 * does the exchange and stores the grant — so a second gateway implementation
 * (docs/remote-mcp.md §2.2) needs no copy of it, and this route stays a
 * provider-neutral courier. Everything here is public config: an authorize URL,
 * a client id, a scope string.
 *
 * The normative contract a second gateway must reproduce is docs/remote-mcp.md
 * §4.8, not this comment. In particular §4.8 carries the requirement this
 * module cannot enforce: the verb that spends the code MUST bind the upstream
 * principal to the charter actor. See connectCall below.
 *
 * The shape, end to end:
 *
 *   1. the user opens  <gateway>/connect/<id>
 *   2. we mint browser-bound state (state.ts, same as sign-in) and 302 to the
 *      upstream's consent screen
 *   3. the upstream calls back to  <gateway>/connect/<id>/callback
 *   4. we verify the state and show the user the code, with the exact tool call
 *      that spends it
 *   5. the user's client calls that verb over its already-authenticated MCP
 *      session; core exchanges the code
 *
 * Step 4 is a copy-paste, and that is a deliberate stop on the ladder. The
 * alternative — the callback calling core itself — needs the gateway to hold an
 * actor token for a user whose MCP session it is not currently serving, which
 * means stashing identity material keyed by state for the length of a consent.
 * That is a real secret-at-rest surface bought for the removal of one paste.
 * ponytail: if the paste becomes the thing people complain about, the upgrade
 * is a short-TTL KV row keyed by the flow id, not a redesign.
 *
 * The attack this route CANNOT stop, and does not pretend to: a user pasting a
 * code an attacker obtained, binding the attacker's upstream account to their
 * own charter identity. Nothing observable at the callback distinguishes that
 * from a genuine paste. The defence belongs to the exchanging verb — §4.8's
 * binding requirement — which sees both identities at once.
 */
import { escapeHtml } from "./html.js";

/** One upstream a deployment can connect to. Public values only — no secrets. */
export type ConnectProvider = {
  /** e.g. "https://app.hubspot.com/oauth/authorize" */
  authorize_url: string;
  client_id: string;
  /**
   * Space-separated, exactly as the upstream expects them. May be empty: some
   * upstreams derive the grant entirely from the app's own registration and
   * reject an empty `scope` parameter less kindly than a missing one.
   */
  scopes: string;
  /** The charter verb that spends the returned code, e.g. "identity.hs.connect". */
  verb: string;
  /** Shown to the user on the consent hand-off; defaults to the id at parse time. */
  label: string;
  /**
   * Extra query parameters for the authorize redirect, for upstreams that need
   * one to issue a refresh token at all — Google wants
   * `access_type=offline&prompt=consent`, and without a seam for it this module
   * would be "provider-neutral" only for upstreams that happen to resemble
   * HubSpot. Parameters this module sets itself are refused (see RESERVED).
   */
  authorize_params?: Record<string, string>;
};

export type ConnectRoute = { id: string; isCallback: boolean };

/**
 * `/connect/<id>` and `/connect/<id>/callback`, or null for anything else.
 *
 * The id is matched against configured providers by the caller, so the pattern
 * here only has to reject shapes — a permissive `[A-Za-z0-9_-]` keeps a decoded
 * path segment from reaching a URL or an error message with anything
 * interesting in it.
 */
export function parseConnectPath(pathname: string): ConnectRoute | null {
  const m = /^\/connect\/([A-Za-z0-9_-]{1,32})(\/callback)?$/.exec(pathname);
  return m ? { id: m[1], isCallback: m[2] !== undefined } : null;
}

/** Query parameters this module owns; config may not override them. */
const RESERVED = new Set(["client_id", "redirect_uri", "scope", "state", "response_type"]);

export type ProviderTable = {
  /**
   * Null-prototype, so an id like `constructor` or `toString` misses instead of
   * returning something off Object.prototype. With a plain `{}` the caller's
   * `if (!provider)` guard does not fail closed: `table["constructor"]` is the
   * Object function, truthy, and the route sails past its 404 into building a
   * URL from `undefined` — an uncaught 500 on an unauthenticated, guessable
   * path. A config key literally named `__proto__` becomes an own property here
   * too, rather than reaching the prototype setter.
   */
  providers: Record<string, ConnectProvider>;
  /**
   * id -> the field that disqualified it. Dropping a malformed entry is right;
   * making the result indistinguishable from "no such provider" is not, and
   * this codebase has already written that argument down — gateway_url.ts
   * exists because a set-but-wrong CHARTER_GATEWAY_URL "had no symptom". A
   * typo'd client_id has exactly that shape, so the route answers 503 naming
   * the field instead of a permanent, ungreppable 404.
   */
  rejected: Record<string, string>;
  /** Set when the whole value was unusable; the route reports it the same way. */
  parseError?: string;
};

/**
 * The configured provider table.
 *
 * Accepts a JSON string or an already-parsed object: wrangler `vars` carry JSON
 * natively, and demanding a string forces operators to write a backslash-escaped
 * one-liner they cannot comment or diff.
 */
export function parseProviders(raw: unknown): ProviderTable {
  const empty = (parseError?: string): ProviderTable => ({
    providers: Object.create(null),
    rejected: Object.create(null),
    ...(parseError ? { parseError } : {}),
  });
  if (raw === undefined || raw === null || raw === "") return empty();
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return empty("not valid JSON");
    }
  }
  // Arrays are rejected whole rather than entry-by-entry: Object.entries would
  // otherwise report indices as rejected provider ids, which reads as five
  // broken providers instead of one wrong shape.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return empty("not a JSON object");
  }
  const table = empty();
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object") {
      table.rejected[id] = "not an object";
      continue;
    }
    // Destructured so the typeof checks narrow: reading through an index
    // signature would leave every field `unknown` at the construction below.
    const { authorize_url, client_id, scopes, verb, label, authorize_params } =
      value as Record<string, unknown>;
    if (typeof authorize_url !== "string" || !authorize_url.startsWith("https://")) {
      table.rejected[id] = "authorize_url";
      continue;
    }
    if (typeof client_id !== "string" || client_id === "") {
      table.rejected[id] = "client_id";
      continue;
    }
    if (typeof scopes !== "string") {
      table.rejected[id] = "scopes";
      continue;
    }
    if (typeof verb !== "string" || verb === "") {
      table.rejected[id] = "verb";
      continue;
    }
    let extra: Record<string, string> | undefined;
    if (authorize_params !== undefined) {
      if (!authorize_params || typeof authorize_params !== "object") {
        table.rejected[id] = "authorize_params";
        continue;
      }
      extra = {};
      let bad: string | null = null;
      for (const [k, v] of Object.entries(authorize_params as Record<string, unknown>)) {
        if (RESERVED.has(k) || typeof v !== "string") {
          bad = `authorize_params.${k}`;
          break;
        }
        extra[k] = v;
      }
      if (bad) {
        table.rejected[id] = bad;
        continue;
      }
    }
    table.providers[id] = {
      authorize_url,
      client_id,
      scopes,
      verb,
      label: typeof label === "string" && label !== "" ? label : id,
      ...(extra ? { authorize_params: extra } : {}),
    };
  }
  return table;
}

/**
 * The redirect URI this gateway will answer for a provider.
 *
 * Resolved against the configured origin rather than concatenated, because
 * gatewayUrlProblem only ever compares `.origin` — so a CHARTER_GATEWAY_URL
 * carrying a path passes every gate, and concatenation would then emit a
 * redirect_uri on a path parseConnectPath never matches. The upstream would
 * deliver codes to a 404 with no signal to the operator. Same idiom as
 * googleConfig's `new URL("/callback", …)`.
 *
 * Built from configuration, never from the request's own Host, for the reason
 * redirect_uri.ts pins its origin: a Worker reachable on a hostname it was not
 * meant to answer must not nominate that hostname as where codes are sent. It
 * is also the value the upstream app registers and the exchanging verb
 * re-checks, so all three have to agree on one string.
 */
export function callbackUri(gatewayUrl: string, id: string): string {
  return new URL(`/connect/${id}/callback`, gatewayUrl).toString();
}

export function upstreamAuthorizeUrl(
  provider: ConnectProvider,
  redirectUri: string,
  state: string,
): string {
  const u = new URL(provider.authorize_url);
  u.searchParams.set("client_id", provider.client_id);
  u.searchParams.set("redirect_uri", redirectUri);
  // REQUIRED by RFC 6749 §4.1.1. HubSpot happens to tolerate its absence;
  // Google, GitHub, Entra, Slack and Salesforce do not, so omitting it would
  // make this module provider-neutral only by one upstream's leniency.
  u.searchParams.set("response_type", "code");
  if (provider.scopes) u.searchParams.set("scope", provider.scopes);
  u.searchParams.set("state", state);
  for (const [k, v] of Object.entries(provider.authorize_params ?? {})) {
    u.searchParams.set(k, v);
  }
  return u.toString();
}

/** What we seal into the state, mirroring the id in the path it must return to. */
export type ConnectState = { p: string };

/**
 * A type predicate, not a boolean helper: it is what joins the seal site's
 * `satisfies ConnectState` to the read site. Without it the two ends agree only
 * by the string "p" appearing in two files, and the first edit that adds a
 * second field to ConnectState breaks that silently.
 */
export function isConnectState(value: unknown, id: string): value is ConnectState {
  return (
    typeof value === "object" && value !== null && (value as { p?: unknown }).p === id
  );
}

/**
 * The wire contract: what the user's client must send to spend this code.
 *
 * Separate from the page that renders it because this — not the HTML — is what
 * a second gateway implementation has to reproduce (§4.8). Rendering is
 * cosmetic; the verb name and the argument keys are the interface.
 */
export function connectCall(
  provider: ConnectProvider,
  code: string,
  redirectUri: string,
): { verb: string; args: Record<string, string> } {
  return { verb: provider.verb, args: { code, redirect_uri: redirectUri } };
}

/**
 * The hand-off page.
 *
 * The arguments are serialized with JSON.stringify, not interpolated into a
 * JSON-shaped template. escapeHtml protects the HTML layer and does nothing for
 * the JSON layer — `&quot;` decodes back to `"` on its way to the clipboard —
 * so a template would let whoever supplies the code choose *fields* of the call
 * the user pastes. It also breaks without an attacker: RFC 6749 permits `"` and
 * `\` in an authorization code, and any upstream that emits one would produce a
 * paste that does not parse.
 *
 * escapeHtml still wraps the result because every value here lands in a text or
 * RCDATA context and one of them is upstream-supplied.
 *
 * Rendered as a <pre> the user copies rather than a link the client can follow:
 * a code is single-use and short-lived, and the point of this page is that the
 * spend happens over the client's authenticated session, not from here.
 */
export function handoffPage(
  provider: ConnectProvider,
  code: string,
  redirectUri: string,
  toolName: string,
): string {
  const label = escapeHtml(provider.label);
  const { verb, args } = connectCall(provider, code, redirectUri);
  const call = escapeHtml(`${toolName} ${JSON.stringify({ verb, args })}`);
  return `<!doctype html><html><head><meta charset="utf-8">
<title>Connect ${label} — charter</title></head>
<body style="font-family:system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem">
<h3>${label} authorized — one step left</h3>
<p>Return to your client and ask it to run this. The code is single-use and
expires within minutes.</p>
<pre style="background:#f4f4f5;padding:1rem;border-radius:6px;white-space:pre-wrap;word-break:break-all">${call}</pre>
<p style="color:#666">The code above is worth nothing on its own — charter
finishes the connection using credentials only the charter server holds.</p>
</body></html>`;
}
