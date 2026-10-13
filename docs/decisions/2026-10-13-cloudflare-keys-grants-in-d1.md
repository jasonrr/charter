# Cloudflare mode: keys and grants live in D1, not in Worker secrets

Date: 2026-10-13. Supersedes the "`CHARTER_KEYS` / `CHARTER_GRANTS` env set with
`wrangler secret put`" row of [2026-10-12-cloudflare-core.md](2026-10-12-cloudflare-core.md).

**Problem.** A Worker secret (or var) is capped at 5.1 kB. A 16-person grants map
is 5.2 kB pretty-printed; the cap is ~20 grants or ~19 keys. Found on the first
real team cutover. `--dry-run` and tests never see it.

**Decision.** The D1 database cloudflare mode already requires gets a `config`
table, one JSON row per map (`keys`, `grants`; 2 MB per row). `secret_map` reads
the row in place of Secret Manager, same 60 s TTL, same last-good and env
fallback; a missing row means the env var is the map (back-compat). `charter
keys` writes the row directly; `charter grants push` replaces it. Rotation no
longer restarts the container.

**Not chosen.** Workers KV: the container cannot use bindings, so it would be a
second REST client for nothing. Grants baked into the image: a grant edit would
be a redeploy. Per-entry rows: a blob row keeps the CLI and the map shape as
they are; split it if someone needs SQL over grants.

**Threat check.** Key digests and grants are not secrets (the digest of a
256-bit key is not reversible; grants name people and verb globs). The
`CF_API_TOKEN` that can already rewrite the audit log can now also rewrite the
maps; that is the same trust boundary as before.
