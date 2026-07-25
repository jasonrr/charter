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
core picks up new versions within ~60s (its own TTL — `admin.reload_keys`
reloads the *key* map, not grants).

## `allow` syntax

Identical to API-key allow-lists — the same `auth.allowed` fnmatch globs, where
`*` spans dots. `content.*.draft*` grants draft verbs but not publish. One
allow-list syntax, two ways of being identified. See `docs/configuration.md`.

## An unknown API key falls through to grants

`X-API-Key` present but unrecognized (revoked, typo'd, never issued) is treated
the same as no key at all — the request falls through to the OAuth actor path.
Revoking a key therefore does **not** revoke a human's grant; grants are
revoked by editing this secret, not `charter-keys`.

## CF Access

The public MCP endpoint is OAuth-protected; **charter-gateway** holds the
CF-Access service token to reach core. CF Access on core is unchanged — stop
distributing its credentials to humans.
