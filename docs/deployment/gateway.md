# charter-gateway

The gateway is what Claude clients connect to. It terminates MCP and OAuth, and
translates to core. It holds the secrets humans used to paste: core's CF Access
service token and the Google client secret.

Core is unchanged by this, with one exception — see "Repoint core" below.

## 1. Create the Google OAuth client

The gateway needs a **Web application** client (not the Desktop client the old
stdio proxy used — a web redirect cannot use a loopback URI).

In Google Cloud Console → APIs & Services → Credentials → Create credentials →
OAuth client ID → Web application:

- Authorized redirect URI: `https://<your-gateway-host>/callback`

Note the client id and secret.

**Register every hostname you'll use.** The redirect URI the gateway builds
follows the incoming request's `Host` header, so a `*.workers.dev` address
*and* any custom domain you route to the Worker each need their own
`https://<host>/callback` entry above. Each hostname beyond
`CHARTER_GATEWAY_URL` also has to be listed in `CHARTER_EXTRA_REDIRECT_ORIGINS`
(step 4) or sign-in on it returns a `503` naming the mismatch. Once it is listed,
though, the Google side is on you: a hostname the gateway will answer but Google
has no redirect URI for fails silently — no error points at the mismatch, just a
client stuck at Google's consent screen or bounced back with an error page.

## 2. Repoint core at that client

Core verifies the actor token's audience against its own configured client id
(`GOOGLE_OAUTH_CLIENT_ID`, checked in `actor_auth.py`), so it must be the
gateway's client id:

    gcloud run services update charter \
      --update-env-vars GOOGLE_OAUTH_CLIENT_ID=<gateway-web-client-id>

**This breaks the old stdio proxy** — ID tokens minted for the Desktop client
stop verifying against core's new client id. That is intended: the proxy is
removed in the same release (sub-project D). **Do not repoint until you are
ready to cut over** — from that moment, every human still on the old proxy is
locked out until they switch to the gateway.

## 3. Grant scope to the humans who will sign in

Do this before anyone connects, not after they hit a 401. On the gateway path a
human's scope comes only from core's `charter-grants` secret, and **no step below
creates it** — nothing in the gateway deploy touches core's secrets. If it does
not exist, or exists and is empty, every signed-in human is locked out:
`grants_for` fails closed, so core answers `unauthorized` (401) and audits the
attempt as `no_grant`.

    cat > /tmp/grants.json <<'JSON'
    {
      "you@yourdomain.com": {"allow": ["*"]}
    }
    JSON
    gcloud secrets create charter-grants --data-file=/tmp/grants.json

Full syntax, editing, and the fail-closed cases: `docs/deployment/grants.md`.
Core re-reads the secret within ~60s, or immediately on `admin.reload_keys`.

## 4. Configure and deploy the gateway

Requires `wrangler` **4.x or later** — `gateway/package.json` pins `4.107.0`.
Wrangler 3's bundled `workerd` predates `cloudflare:email`, which the `agents`
package imports, so the Worker fails to start; it also silently falls back to
`compatibility_date` `2025-07-18` at runtime (`wrangler.jsonc` itself is left
unchanged on disk — the fallback only affects what the Worker actually runs
with). Always invoke it via `npx wrangler` (or `npm run deploy`) from
`gateway/` so it resolves the pinned version rather than whatever is on
`PATH`.

    cd gateway
    npx wrangler kv namespace create OAUTH_KV
    # put the returned id into wrangler.jsonc's kv_namespaces entry

**Use a fresh namespace.** Redirect URIs are screened at *registration* time, so
any client already in an existing `OAUTH_KV` keeps whatever URIs it registered
under the old rules and bypasses the control entirely. If you reuse a namespace
from before that screening existed, purge its `client:*` records first and make
the clients re-register.

Set the non-secret values in `wrangler.jsonc` → `vars`:

- `CHARTER_CORE_URL` — your core endpoint, https only
- `CHARTER_ALLOWED_DOMAIN` — e.g. `@yourdomain.com`, matching core's setting
- `GOOGLE_CLIENT_ID` — from step 1
- `CHARTER_GATEWAY_URL` — **required.** This gateway's own canonical origin,
  https, e.g. `https://<your-gateway-host>`. Two things read it: which redirect
  URIs a dynamically registered client may claim as "this gateway", and what the
  gateway publishes as its own resource identity in protected-resource metadata
  (`src/prm.ts`). Both are pinned to this value rather than read off the incoming
  request, so a Worker reachable on a Host it wasn't meant to answer can't get
  that Host whitelisted at registration time. If you answer more than one
  hostname (see "Register every hostname" above), add the others to
  `CHARTER_EXTRA_REDIRECT_ORIGINS` below.

  Getting it wrong is loud, in three places (`src/gateway_url.ts`):

  - **Unset, or not an `https://` URL** — `/authorize`, `/authorize/continue`
    and `/callback` return `503` naming it, alongside the other required config.
  - **Set but not this deployment's origin** — the same three routes return
    `503` naming both origins: `CHARTER_GATEWAY_URL is https://a, but this
    request arrived at https://b`. A request arriving on a loopback host is
    exempt, so `wrangler dev` still runs against a production-shaped config.
  - **Unusable at all** — `POST /register` answers `500 server_error` rather
    than screening against an empty origin, and the metadata endpoints answer
    `500` rather than publishing an origin the operator never chose.

  The shipped placeholder is `https://charter-gateway.example.com`. It used to be
  a `workers.dev` address, which is a real namespace a third party can register:
  an unedited placeholder would have let whoever holds that subdomain register
  redirect URIs accepted as "this gateway", with the consent screen showing their
  host as the destination. `example.com` is IANA-reserved, and the mismatch check
  above means an unedited value now stops sign-in instead of quietly widening it.
- `CHARTER_EXTRA_REDIRECT_ORIGINS` — optional, comma-separated extra https
  origins clients may register redirect URIs on. Empty (closed) by default; see
  "Sign-in is bound to one browser" below before widening it.

Then the secrets, which are never written to a file:

    npx wrangler secret put CF_ACCESS_CLIENT_ID
    npx wrangler secret put CF_ACCESS_CLIENT_SECRET
    npx wrangler secret put GOOGLE_CLIENT_SECRET
    npx wrangler secret put OAUTH_STATE_SECRET      # e.g. openssl rand -base64 32

`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` are core's CF Access service
token — the same pair the proxy carried, now held once. They are a *network*
gate: they say the caller is the gateway, not what the caller may do. Skip them
if your core is not behind CF Access.

**Do not mint an API key for the gateway.** This reverses the proxy's advice, on
purpose. Core's `bridge()` resolves `X-API-Key` *before* the actor-token +
grants path, so a key present on a human's call replaces that human's grant with
the key's allow-list: everyone signed in would run with the union of what
everyone needs, `charter-grants` would never be read, and the audit row would
name the key as the actor with the human only in `on_behalf_of`. The gateway now
makes that impossible rather than merely discouraged — it never sends
`X-API-Key` on a call that carries `X-Actor-Token` (`gateway/src/core.ts`
`authHeaders`, unit-tested). Human scope comes from grants
(`docs/deployment/grants.md`), which core applies to the actor token, and every
human needs one before they can do anything.

There is an optional `CHARTER_API_KEY` secret. It is sent only on a call with no
signed-in human behind it, which no route reaches today — it exists for the
headless-MCP path sketched in `docs/remote-mcp.md` §7.1 and should stay unset.

**Upgrading from an earlier gateway deploy:** `CHARTER_CREDENTIAL` (the packed
`cf-id:cf-secret:api-key` form) is gone and is now ignored. Set the two CF Access
secrets above, then `npx wrangler secret delete CHARTER_CREDENTIAL` — leaving it
set does nothing, but it reads like live config. If you skip the new secrets,
CF Access rejects the gateway at core's tunnel and every tool call fails.

`OAUTH_STATE_SECRET` is the HMAC key that signs the sign-in `state` and binds it
to the browser that started the flow. It is what stops an attacker from having a
victim's Google identity delivered into a grant the attacker holds — see
"Sign-in is bound to one browser" below. Any high-entropy string works; it is
never sent anywhere, so rotating it costs only the sign-ins currently in flight.

**Nothing here may be left unset.** If any of `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `OAUTH_STATE_SECRET`, `CHARTER_ALLOWED_DOMAIN` or
`CHARTER_GATEWAY_URL` is missing, the sign-in routes — `/authorize`,
`/authorize/continue` and `/callback`, the full set in `src/routes.ts` — return
`503` naming exactly which ones, rather than failing somewhere further away. An
empty `GOOGLE_CLIENT_ID` used to
surface as Google's own "Could not determine client ID from request" in the
user's browser, and `/authorize/continue` was once missing from this gate
entirely, so an unset `OAUTH_STATE_SECRET` reached `crypto.subtle.importKey` as
a zero-length key and came back a bare `500`. There is deliberately **no**
unsigned-state fallback: without
`OAUTH_STATE_SECRET` the sign-in routes do not run at all. An unset CF Access
pair is simply omitted from the request rather than sent as empty headers, so it
fails at the tunnel as a clean rejection rather than a raw exception surfaced to
the model.

    npx wrangler deploy

## 5. Connect a client

Add the endpoint to `.mcp.json`:

    {
      "mcpServers": {
        "charter": { "type": "http", "url": "https://<your-gateway-host>/mcp" }
      }
    }

The client discovers the OAuth metadata, opens a browser, and you sign in with
Google. No secret is pasted, and nothing is stored on your disk.

## Verifying

Metadata endpoint:

    curl -s https://<your-gateway-host>/.well-known/oauth-authorization-server | jq .

Expect `authorization_endpoint`, `token_endpoint`, and
`code_challenge_methods_supported` containing `S256`.

Protected-resource metadata (RFC 9728) — this is what an MCP client reads to
find the authorization server, so a deploy where it is wrong looks to a client
like a gateway with no OAuth at all:

    curl -s https://<your-gateway-host>/.well-known/oauth-protected-resource/mcp | jq .

Expect `resource` equal to `https://<your-gateway-host>/mcp`,
`authorization_servers` listing `https://<your-gateway-host>`, and
`bearer_methods_supported` of `["header"]`. The bare
`/.well-known/oauth-protected-resource` is served too, describing the origin
itself rather than `/mcp` — clients probe both. Both are built from
`CHARTER_GATEWAY_URL`, so a `resource` that isn't the host you curled means that
var is stale (see step 4).

**Security checks** — confirm these before treating a deploy as done, not just
the happy path:

- `code_challenge_methods_supported` (above) includes `"S256"` — meaning S256
  is *offered*. It does not mean PKCE is required: the OAuth library treats
  PKCE as optional and advertises `"plain"` alongside `"S256"`, with no option
  to withdraw either. See "PKCE is offered, not required" below.
- Unauthenticated `POST /mcp` returns `401`, and its `WWW-Authenticate` header
  carries `resource_metadata="https://<your-gateway-host>/.well-known/oauth-protected-resource/mcp"`:

      curl -s -o /dev/null -D - -X POST https://<your-gateway-host>/mcp \
        -H 'Content-Type: application/json' -d '{}' | grep -i www-authenticate

- An unknown path returns `404`, not a cheerful `200`. The gateway's catch-all
  answers only `/`; everything else is a 404. This is the check that would have
  caught the missing metadata endpoint, which for a while was answered by that
  catch-all as an unparseable `200 charter-gateway`:

      curl -s -o /dev/null -w '%{http_code}\n' https://<your-gateway-host>/nope
      # expect 404

- A forged `state` on `/callback` returns `400`. The state is HMAC-signed and
  bound to a browser cookie (`gateway/src/state.ts`, unit-tested), so this is
  belt-and-braces rather than the only line of defence — but verify it on every
  deploy that touches `/callback`:

      curl -s -o /dev/null -w '%{http_code}\n' \
        "https://<your-gateway-host>/callback?state=not-json&code=x"
      # expect 400

  A `state` that is validly signed but arrives without its cookie must also
  fail, which is the check that actually matters:

      # drive /authorize, keep the redirect URL, then replay it with no cookie jar
      curl -s -o /dev/null -w '%{http_code}\n' \
        "https://<your-gateway-host>/callback?code=x&state=<signed-state>"
      # expect 400 — "could not verify this sign-in in this browser…"

- Registering a client with a public redirect URI is refused:

      curl -s -o /dev/null -w '%{http_code}\n' -X POST \
        https://<your-gateway-host>/register -H 'Content-Type: application/json' \
        -d '{"client_name":"x","redirect_uris":["https://attacker.example/collect"],"token_endpoint_auth_method":"none"}'
      # expect 400 (invalid_redirect_uri)

- `GET /authorize` for a registered client returns **200 HTML** (the consent
  screen), not a 302 to Google, and the page shows the client's redirect URI
  origin.
- An authenticated `tools/list` shows `charter_read` with `readOnlyHint: true`.

**Happy path**, from a real client: point it at `https://<your-gateway-host>/mcp`,
complete the Google sign-in, and run `verbs.list` through `charter_read`.
Expect the catalog scoped to that email's grant.

**If it fails, read the `error` field, not the status code.** Both of the two
likely causes are a `401` from core, arriving as an errored tool result whose
text starts `HTTP 401:` and carries core's JSON body — the body is what tells
them apart:

- `"error": "unauthorized"` — your email has no grant. Core audits it as
  `no_grant`; fix it in `charter-grants` (step 3, and
  `docs/deployment/grants.md`). This is also what a *malformed* entry for your
  email looks like from out here, so check core's logs for a
  `charter grants: … -- fail-closed` line before assuming the entry is absent.
- `"error": "actor_invalid"`, with a `detail` naming the rejection — core is not
  pointed at the gateway's Google client id (step 2), so the audience check on
  your ID token fails.

An **empty catalog is not one of the outcomes**: `verbs.list` is in core's
`_ALWAYS_ALLOWED`, so any caller core authenticated at all sees at least that
verb. Zero verbs would mean something stranger than a missing grant.

A `401` at the MCP transport layer — not inside a tool result — is a different
thing again: that is the gateway telling the client its own session is over
(no or expired MCP token, or a Google refresh that no longer works) and it
should re-run OAuth. Neither grants nor core's client id is involved.

**Negative authorization cases** — these are what prove the gateway stayed
non-authoritative: the decision and the audit record both happen in core, not
here.

- A verb outside the caller's grant returns `denied`.
- An email with no grant at all gets `unauthorized` — and core audits it as
  `no_grant`. This is the check that proves grants are live: if a signed-in
  email with no grant can run verbs, the gateway is sending an API key and every
  human is running as it.
- Core's audit table shows the call with `interface = "oauth"` and the
  signed-in email as the actor — not `on_behalf_of` under some other actor.

## Cutover from the stdio proxy (one-time)

Ships with the release that removes `plugin/proxy/` (`remote-mcp.md` §7.1).
In order:

1. Deploy the gateway; verify per this runbook.
2. Set core's `GOOGLE_OAUTH_CLIENT_ID` to the gateway's Web application
   client id and redeploy core (`remote-mcp.md` §4.6 "Audience"). From this
   moment the old proxy cannot verify actors — expected, there are no
   adopters on it.
3. Populate `charter-grants` for every interactive human
   (`deployment/grants.md`); an empty grants file is a locked-out
   deployment, not a permissive one.
4. Delete the old Google **Desktop** OAuth client in the Cloud console.
5. Update the installed plugin (`claude plugin install charter@charter`);
   verify per `INSTALL.md` step 7.

## Known limitations

- **A response over 1 MB comes back as an error, not a partial result.**
  `core.ts` caps what it reads from core at 1 MB — the same cap the stdio proxy
  had on what may enter a model's context — and appends `...[truncated]`. A
  truncated body is unparseable JSON, so reporting a 2xx as success would hand
  the model a broken result and tell it that it worked; instead a truncated
  response is returned with `isError: true` even though the HTTP call succeeded.
  The model sees a failure it can act on rather than silently wrong data. This
  is an interim behaviour: the designed answer is resource-link-out
  (`docs/remote-mcp.md` §4.5), which is sub-project C. Until then, a verb whose
  result can exceed 1 MB is not usable through the gateway — narrow the query,
  or have the verb return a reference.

- **Sessions cost a Google round-trip past the one-hour mark.** The gateway
  re-mints the Google ID token on demand, but the re-minted token is never
  written back to the OAuth grant — so every tool call after the first hour
  re-mints again instead of reusing a cached one. Worse, `google.ts`
  deliberately *adopts* a rotated refresh token when Google sends one, and
  because the re-mint result is discarded, a rotation ends the session at
  "sign in again" with no in-place recovery. The fix is
  `OAuthProvider`'s `tokenExchangeCallback`, which writes props back after a
  refresh; see the `ponytail:` note in `apiHandler`'s `fetch` in
  `gateway/src/index.ts`, just above the `freshIdToken` call ("freshIdToken
  returns a rotated identity and we discard it..."). When a refresh does fail,
  the gateway now answers `401` with a `WWW-Authenticate` header so the client
  re-runs OAuth on its own, instead of the session silently going dead.

- **PKCE is offered, not required.** OAuth 2.1 and the MCP spec want S256, but
  `@cloudflare/workers-oauth-provider` hard-codes
  `code_challenge_methods_supported: ["plain", "S256"]`, defaults a request with
  no `code_challenge_method` to `plain`, and treats PKCE as optional
  altogether — with no configuration hook for any of it. The gateway could
  refuse non-S256 requests in its own `/authorize`, but the metadata document
  would still advertise `plain`, so clients would be told one thing and handed
  another. Left as-is deliberately rather than fought. Real MCP clients send
  S256.
- **Sign-in is bound to one browser — and an earlier version of this document
  was wrong about why that matters.** It described the unsigned `state` as "a
  privilege downgrade and confused-deputy, not a privilege escalation… the
  attacker only gets the access their own account already has." **That was
  false, and an operator could have accepted the risk on the strength of it.**

  The escalating direction was open. Because client registration is public and
  accepts any `redirect_uris`, an attacker could register a client pointing at
  their own server, call `/authorize` to mint a `state`, and phish a victim into
  completing a *genuine* Google consent for the *genuine* charter app. The
  callback would bind the **victim's** identity to the **attacker's** grant and
  hand the attacker an authorization code. Redeeming it gave the attacker an MCP
  token whose every tool call carried the victim's Google ID token — so core
  correctly verified a real token, applied the victim's grants, and audited the
  calls as the victim. That is full account takeover, not a downgrade. PKCE did
  not help (the attacker was the legitimate client of their own flow and held
  both halves), and neither did the redirect-URI check (the redirect URI was
  genuinely registered).

  **Fixed.** The `state` is now HMAC-signed with `OAUTH_STATE_SECRET` *and*
  carries a random nonce mirrored in a `__Host-` prefixed, `HttpOnly`, `Secure`,
  `SameSite=Lax` cookie with a 10-minute TTL. `/callback` requires both a valid
  signature and a matching cookie. Each sign-in gets its own cookie *name*, so
  starting a second one — a second MCP client, or a double-clicked connect —
  does not invalidate the first. Signing alone would not have been enough —
  an attacker can always ask us to sign a state of their own; the cookie is the
  half they cannot plant in someone else's browser. Logic and edge cases live in
  `gateway/src/state.ts` with unit tests (`gateway/test/state.test.ts`).

  **The phishing variant is closed too, by two further changes.**

  *Registration is constrained.* `POST /register` now accepts only redirect URIs
  that are loopback (`http://localhost`, `http://127.0.0.1`, `http://[::1]`, any
  port) or https on the gateway's own origin. A loopback URI resolves on the
  victim's own machine, so there is nowhere for an attacker to collect a code —
  this is the control that actually *prevents* the attack. No vendor allow-list
  is maintained. Entries outside that set are dropped from the registration and
  the rest is registered; a registration with nothing acceptable left is refused
  with `invalid_redirect_uri`. Logic and edge cases (userinfo smuggling,
  percent-encoded and unicode hosts, `localhost.evil.example`) are in
  `gateway/src/redirect_uri.ts` with unit tests.

  **This can break a client, and the lever is `CHARTER_EXTRA_REDIRECT_ORIGINS`.**
  VS Code's dynamic registration sends a mixed array —
  `https://insiders.vscode.dev/redirect`, `https://vscode.dev/redirect`,
  `http://127.0.0.1/`, `http://127.0.0.1:33418/`. It keeps working, because its
  loopback URIs are accepted and those are its primary flow, but its
  non-loopback fallback (used when port 33418 is taken) is dropped. To restore
  it, add the origins to that var in `wrangler.jsonc`:

      "CHARTER_EXTRA_REDIRECT_ORIGINS": "https://vscode.dev,https://insiders.vscode.dev"

  It is a comma-separated origin list and defaults to empty — closed.

  *Consent is required before forwarding to Google.* `/authorize` now renders an
  interstitial that the user must click through. This is not a preference; the
  MCP spec's authorization Security Considerations require it for exactly this
  architecture — one static upstream client id, open registration, forwarding to
  a third-party authorization server:

  > MCP proxy servers using static client IDs **MUST** obtain user consent for
  > each dynamically registered client before forwarding to third-party
  > authorization servers (which may require additional consent).

  The page shows the **redirect URI's origin**, deliberately not `client_name`:
  the name is whatever the registrant typed and is never verified, so it is the
  field an attacker uses to look legitimate (a test registration called
  "Charter (totally legit)" makes the point). The origin is where the code will
  actually be delivered. Consent is bound to the flow through the same signed
  state and cookie as the rest of sign-in, so it cannot be replayed or skipped,
  and it is per registered client rather than a one-time global dismissal.
  `/callback` *requires* a consent flag carried inside the signed state, so the
  screen cannot be skipped by construction rather than by circumstance.

  **Widening `CHARTER_EXTRA_REDIRECT_ORIGINS` re-opens this attack** for any
  client that registers on an origin you add. An attacker who can host a page on
  that origin — or who controls any app already hosted there — can register a
  client pointing at it and collect a phished user's authorization code, exactly
  as before. Add an origin only when you control what can be served from it, and
  prefer telling a client to use its loopback flow.

  **Forward path: Client ID Metadata Documents (CIMD).** A `SHOULD` in the
  2026-07-28 draft, with dynamic client registration deprecated but retained for
  back-compat. CIMD makes the client id a fetchable URL, so the consent screen
  can show a name and origin the gateway *verified* rather than merely
  displaying. That is what makes consent trustworthy instead of only present —
  today's screen still asks a human to recognise an origin. Not implemented on
  this branch; tracked as follow-up.

- **`index.ts` has no unit tests, so the wiring is verified by curl, not CI.**
  `gateway/test/` cannot import `src/index.ts`: it pulls in `cloudflare:*`
  built-ins (through `agents/mcp` and `@cloudflare/workers-oauth-provider`) that
  plain vitest cannot resolve. Everything with a decision in it was pushed down
  into a pure module and is tested there — `prm.ts`, `routes.ts`,
  `gateway_url.ts`, `redirect_uri.ts`, `state.ts`, `core.ts`, `redact.ts`,
  `google.ts`, `tools.ts`, 142 tests. But their *composition* in `index.ts` is
  not: the protected-resource route and its CORS preflight, the `404` catch-all,
  the `resource_metadata` decoration on a `401` from `/mcp`, and the config gate
  that turns `missingConfig`/`gatewayUrlProblem` into a `503` are all reached
  only through the Worker. That is exactly why the Verifying section above has a
  curl for each of them; run them on any deploy that touches `index.ts`. Closing
  this properly means `@cloudflare/vitest-pool-workers`.

- **Five moderate `npm audit` advisories are knowingly deferred**, all one
  root cause: a Windows path-traversal issue in `@hono/node-server` (used only
  by the MCP SDK's optional Node transport), reached transitively by
  `@modelcontextprotocol/sdk` → `agents` → `@cloudflare/ai-chat` /
  `@cloudflare/codemode`. `npm audit fix --force` "fixes" it by downgrading
  `@modelcontextprotocol/sdk` to `1.24.3`, which reintroduces a *high*-severity
  advisory the current version already fixed — a strictly worse trade. No
  version selection clears both at once, and the vulnerable code path
  (`serve-static`'s Windows file serving) is dead weight for a Cloudflare
  Worker: it is absent from the built bundle (verified — `wrangler deploy
  --dry-run`'s output contains no reference to it). Leave it; don't let a
  future `npm audit fix --force` regress the SDK to "solve" this.

## What the gateway does not do

- It makes **no authorization decision** and writes **no audit row**. Core
  verifies the Google token itself and applies grants.
- It **holds no scope of its own** on a human's call. The only credential it
  adds is the CF Access service token, which opens the tunnel and grants
  nothing. See "Do not mint an API key for the gateway" above.
- It never forwards the client's MCP token upstream — the MCP spec forbids
  passthrough. Core sees the caller's *Google* ID token, which the gateway
  cannot forge, plus the CF Access pair.
- **HubSpot connect is not available through the gateway yet.** That flow needs a
  loopback listener the old proxy had. Verbs needing a HubSpot identity return
  `hs_identity_required` until it is re-hosted.
