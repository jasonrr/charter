# Grants (`charter-grants`)

A charter grants powers to named parties. This secret is that map: which verbs
each verified person may call. The interactive OAuth path derives a caller's
allow-list from it. Fail-closed — an email with no grant can sign in but gets no
scope (401). That refusal is audited under the verified email (`result =
no_grant`), so probing by a still-valid-but-ungranted account leaves a trail.

## Create it

```bash
cat > /tmp/grants.json <<'JSON'
{
  "jason@yourdomain.com": {"allow": ["*"]},
  "marketer@yourdomain.com": {"allow": ["data.*", "content.*.draft*"]}
}
JSON
gcloud secrets create charter-grants --data-file=/tmp/grants.json
```

Edit later with `gcloud secrets versions add charter-grants --data-file=...`;
core picks up new versions within ~60s (its own TTL), or immediately via
`admin.reload_keys`, which force-reloads both the key map and the grants map.

## When it is malformed

This is a hand-edited secret, so it fails closed rather than raising: a bad
entry locks its own account out and says so in the log. Nothing surfaces to the
caller — they get the same generic `unauthorized` (401) as an email with no
grant at all — so **the log line is the only symptom**. Check core's logs when a
grant that looks present doesn't work.

Per-entry (`secret_map.allow_list`, logged at ERROR, that email only):

| Written | Logged |
|---|---|
| `"jason@…": ["*"]` — the record isn't an object | `charter grants: entry for jason@… is a list, not an object -- fail-closed` |
| `"jason@…": {"allow": "*"}` — `allow` isn't a list | `charter grants: allow for jason@… is a str, not a list -- fail-closed` |
| `"jason@…": {"allow": [["*"]]}` — a non-string element | `charter grants: allow for jason@… has a non-string element -- fail-closed` |

The `{"allow": "*"}` typo is the one to know: a JSON *string* would otherwise
iterate character by character in `auth.allowed`, where the single `"*"`
character matches every verb. It is rejected outright instead.

Whole-secret (`secret_map.SecretMap.get`, logged at WARNING, everyone): payload
that isn't a JSON object — a top-level array, or invalid JSON — is
`charter grants fetch failed: …`. Core keeps the last-good map if it has one; on
a cold start it falls back to `CHARTER_GRANTS`, and to an empty map if that is
unusable too. An empty map is a locked-out deployment, not a permissive one.

**Key records fail closed the same way.** `charter-keys` entries share this
validation — one copy, `secret_map.allow_list`, both paths — and additionally
require a non-empty string `name`
(`charter keys: entry sha256:… has no usable name -- fail-closed`). Key-record
log lines name the sha256 digest, not the key. A malformed key record is treated
as no key at all, which means it falls through to the OAuth actor path below.

## `allow` syntax

Identical to API-key allow-lists — the same `auth.allowed` fnmatch globs, where
`*` spans dots. `content.*.draft*` grants draft verbs but not publish. One
allow-list syntax, two ways of being identified. See `docs/configuration.md`.

## An unknown API key falls through to grants

`X-API-Key` present but unrecognized (revoked, typo'd, never issued) is treated
the same as no key at all — the request falls through to the OAuth actor path.
Revoking a key therefore does **not** revoke a human's grant; grants are
revoked by editing this secret, not `charter-keys`. This can *widen* scope: a
human whose narrowly-scoped key is revoked or mistyped lands at their grant's
scope instead, which may be broader than the key ever granted, and the audit
row's `interface` flips from the key's own value to `"oauth"`.

## Using a grant (through the gateway)

**charter-gateway** is what a granted human connects to — it is in this repo
(`gateway/src/`) and sub-project B has landed. Point an MCP client at
`https://<your-gateway-host>/mcp`, sign in with Google, and that's it: no key to
paste, no credential field to fill, no `charter_login` (OAuth at install replaces
it). Deploying it is `docs/deployment/gateway.md`.

Grants are the *only* source of a signed-in human's scope on that path. The
gateway never sends `X-API-Key` on a call carrying `X-Actor-Token`
(`gateway/src/core.ts`'s `authHeaders`, unit-tested), because core resolves the
key before the actor token and a key would silently replace every human's grant
with the gateway's own allow-list. So an email with no grant here can sign in and
do nothing.

**Do not configure the stdio proxy with a placeholder credential.** Earlier
revisions of this document said to, and that advice is dead: the proxy is
deprecated and removed in the same release as the gateway
(`docs/remote-mcp.md` §7.1), and it stops working the moment core is repointed at
the gateway's Google client id (`gateway.md` step 2) — its Desktop-client ID
tokens no longer verify.

## CF Access

**charter-gateway** holds core's CF-Access service token
(`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`, set as Worker secrets), so
those credentials are no longer distributed to humans. CF Access on core is
unchanged — only who carries the service token changed. It is a *network* gate:
it says the caller is the gateway, not what the caller may do. Scope still comes
from this file.
