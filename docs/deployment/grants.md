# Grants (`charter-grants`)

A charter grants powers to named parties. This secret is that map: which verbs
each verified person may call. The interactive OAuth path derives a caller's
allow-list from it. Fail-closed — an email with no grant can sign in but gets no
scope (401).

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

## Using a grant today (no key)

There is no gateway yet (see below), so a grants-only human goes through the
same plugin proxy as a key holder. The plugin's `credential` config field is
required, so put any placeholder value in the `api-key` slot (e.g.
`cf-id:cf-secret:none` behind Cloudflare Access, or just `none` otherwise) —
an unrecognized key falls through to the grants path above, same as a revoked
one. Then run `charter_login` so the actor token backs your grant. If the
credential resolves to empty, the proxy logs `charter: no API key set — run
/plugin configure charter...` at startup (`charter_mcp.js`); that line is
harmless for a grants-only human — ignore it and sign in with `charter_login`.

## CF Access (planned)

There is no gateway in this repo yet — that's sub-project B, unbuilt. Once it
ships, the public MCP endpoint will be OAuth-protected and **charter-gateway**
will hold the CF-Access service token to reach core, so this secret's
CF-Access credentials no longer need to be distributed to humans. Until then,
CF Access on core (where deployed) works as it does today.
