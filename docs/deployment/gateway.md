# charter-gateway

The gateway is what Claude clients connect to. It terminates MCP and OAuth, and
translates to core. It holds the two secrets humans used to paste: the core
credential and the Google client secret.

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
`https://<host>/callback` entry above. If you register only one, sign-in works
on that hostname and fails silently on the other — there's no error pointing
at the mismatch, just a client stuck at Google's consent screen or bounced
back with an error page.

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

## 3. Configure and deploy the gateway

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

Set the non-secret values in `wrangler.jsonc` → `vars`:

- `CHARTER_CORE_URL` — your core endpoint, https only
- `CHARTER_ALLOWED_DOMAIN` — e.g. `@yourdomain.com`, matching core's setting
- `GOOGLE_CLIENT_ID` — from step 1

Then the two secrets, which are never written to a file:

    npx wrangler secret put CHARTER_CREDENTIAL      # cf-id:cf-secret:api-key
    npx wrangler secret put GOOGLE_CLIENT_SECRET

The credential is the same composite form the proxy used. Mint its API key with
`charter keys mint` and give it the allow-list the *gateway* needs — it is the
gateway's own credential, not a human's. Human scope comes from grants
(`docs/deployment/grants.md`), which core applies to the actor token. If
either secret is left unset, the gateway fails legibly rather than throwing —
requests get a clean 401/error result instead of a raw exception surfaced to
the model.

    npx wrangler deploy

## 4. Connect a client

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

**Security checks** — confirm these before treating a deploy as done, not just
the happy path:

- `code_challenge_methods_supported` (above) includes `"S256"` — PKCE is on.
- Unauthenticated `POST /mcp` returns `401`.
- A forged `state` on `/callback` (invalid JSON, or a well-formed-but-forged
  `clientId`/`redirectUri`) returns `400`. This check is the only thing
  standing between a forged `state` and an open redirect in the authorization
  server, and it has no regression test anywhere — verify it by hand on every
  deploy that touches `index.ts`'s `/callback` handler:

      curl -s -o /dev/null -w '%{http_code}\n' \
        "https://<your-gateway-host>/callback?state=not-json&code=x"
      # expect 400

- An authenticated `tools/list` shows `charter_read` with `readOnlyHint: true`.

**Happy path**, from a real client: point it at `https://<your-gateway-host>/mcp`,
complete the Google sign-in, and run `verbs.list` through `charter_read`.
Expect the catalog scoped to that email's grant — if you see none, your email
has no grant (see `docs/deployment/grants.md`); if you get a 401, core is not
pointed at the gateway's Google client id (step 2).

**Negative authorization cases** — these are what prove the gateway stayed
non-authoritative: the decision and the audit record both happen in core, not
here.

- A verb outside the caller's grant returns `denied`.
- An email with no grant at all gets `unauthorized`.
- Core's audit table shows the call with `interface = "oauth"` and the
  signed-in email as the actor.

## Known limitations

- **Sessions cost a Google round-trip past the one-hour mark.** The gateway
  re-mints the Google ID token on demand, but the re-minted token is never
  written back to the OAuth grant — so every tool call after the first hour
  re-mints again instead of reusing a cached one. Worse, `google.ts`
  deliberately *adopts* a rotated refresh token when Google sends one, and
  because the re-mint result is discarded, a rotation ends the session at
  "sign in again" with no in-place recovery. The fix is
  `OAuthProvider`'s `tokenExchangeCallback`, which writes props back after a
  refresh; see the `ponytail:` note in `buildServer`'s `run` closure in
  `gateway/src/index.ts`, just above the `freshIdToken` call ("freshIdToken
  returns a rotated identity and we discard it...").
- **The OAuth `state` is unsigned and not bound to a browser session.** An
  attacker who observes a victim's in-flight `state` (e.g. from a shared
  clipboard, a logged URL, or a browser history sync) can replay it with
  their own Google sign-in — the victim's agent then acts as the *attacker's*
  charter identity. This is a privilege downgrade and confused-deputy, not a
  privilege escalation: core still authorizes strictly on the ID token's
  identity, so the attacker only gets the access their own account already
  has. It's still worth knowing about. The complete fix is an HMAC-signed
  `state` bound to a cookie set in the browser that started the flow.
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
- It never forwards the client's MCP token upstream. Calls to core use the
  gateway's own credential — the MCP spec forbids passthrough.
- **HubSpot connect is not available through the gateway yet.** That flow needs a
  loopback listener the old proxy had. Verbs needing a HubSpot identity return
  `hs_identity_required` until it is re-hosted.
