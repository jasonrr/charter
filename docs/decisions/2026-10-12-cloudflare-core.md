# Design: charter on Cloudflare only (Containers), no GCP in the deploy path

Date: 2026-10-12. Decided with Jason: cost $5–25/mo is fine; the goal is less architecture and an OSS install that needs ONE Cloudflare account and nothing from Google Cloud (Google sign-in stays; it is not GCP).

## Problem

Today an adopter needs: Cloudflare (Worker gateway + Tunnel + Access) AND GCP (Cloud Run, Cloud Build, Artifact Registry, Secret Manager, BigQuery for audit, WIF for CI). The engine itself (~2,600 lines Python) uses GCP for only four things: keys/grants (Secret Manager), audit (BigQuery), result offload (GCS, off in prod), and Google ID-token verification (not GCP). RC's pack adds Firestore, more Secret Manager secrets, BigQuery data verbs, SA impersonation, and the `gog` binary.

## Chosen approach: keep the Python core, run it in a Cloudflare Container behind the existing gateway Worker

Rejected: Python Workers (cannot load google-* / grpc packages, cannot run `gog`, 10 ms CPU on free). Rejected: TypeScript rewrite (packs are Python; RC's pack is large; rewrite is the opposite of less work).

Shape after the change (one `wrangler deploy` ships all of it):

```
Claude surface ──MCP──▶ gateway Worker ──DO binding──▶ Container (python:3.12-slim + gog)
n8n / dashboards /                │                          │
Airtable script ──POST /call──────┘                          ├─ D1  (audit log)
  (X-API-Key)                                                └─ env secrets (keys, grants, pack creds)
```

Per engine dependency:

| Today (GCP) | After (Cloudflare) | Note |
|---|---|---|
| Secret Manager `charter-keys`, `charter-grants`, re-read every 60 s | `CHARTER_KEYS` / `CHARTER_GRANTS` env (already the cold-start fallback) set with `wrangler secret put`; rotation = redeploy (~1–2 min rollout) | `charter keys add` gains a `--backend env` path that prints the merged JSON; CI already syncs grants on gateway deploy |
| BigQuery `audit` table, `insert_rows_json` | D1 table `audit`, same columns; core writes through the D1 HTTP API with a scoped CF API token in env | keeps the fail-closed "pre" audit semantics in core; `sql/audit_table.sql` gets a D1 twin |
| GCS result offload | cut from v1 (off in prod today); R2 via S3 API later if a result ever exceeds 1 MB | |
| Google ID-token verify (`google.oauth2.id_token`) | unchanged | pure HTTPS to Google certs |
| `cloudflared` sidecar + Tunnel + CF Access service token | gone. Worker reaches the container over the Durable Object binding | removes 2 secrets, 1 container, 1 tunnel, 1 Access app |
| Cloud Build + Artifact Registry + `gcloud run deploy` + WIF | `wrangler deploy` builds and pushes the image; GitHub Action = `cloudflare/wrangler-action` with one API token | |

Gateway Worker changes: a `Container` Durable Object class + binding; `CHARTER_CORE_URL` replaced by the binding; a `POST /call` passthrough for headless callers (n8n, rc-dashboards cron, the Airtable contracts script) which send `X-API-Key` as today. Core keeps checking keys, so no new auth code.

Container config: instance `basic` (¼ vCPU, 1 GiB, 4 GB disk; prod uses 512 Mi + <1 % of a vCPU). `sleepAfter` default (10 min); cold start 1–3 s on the first call after idle. Est. $5 plan + ≤$20 usage; ~$50/mo today on Cloud Run.

## Phases

1. **Engine (OSS, charter repo):** pluggable `secrets` (env) and `audit` (D1) backends chosen by env var; `deploy/` gets `wrangler.jsonc` + Container class; INSTALL.md rewritten to "one Cloudflare account". Staging = a wrangler environment. Deliverable: a stranger deploys charter with the reference packs from a clean clone.
2. **RC pack (rc-data-tools):** pack creds move from Secret Manager reads to env; Firestore `ops_bridge_identities` + `qbo_token` → D1 (same HTTP client as audit); BigQuery *data* verbs keep GCP as a data source only, authed with a service-account key JSON in env (ADC via metadata server no longer exists; the query-SA impersonation still works from a key). `gog` goes in the image as today. Cut over, then delete Cloud Run service, tunnel, Access app, Cloud Build trigger, WIF pool.

## Cut (and why)

- Live key/grant reload without redeploy — a 1–2 min rollout is acceptable; no concrete break.
- R2 result offload — disabled in prod today.
- Container autoscaling / multiple instances — p99 CPU <1 % of a vCPU; one instance.
- Snapshots, persistent disk — core is stateless; `/tmp` only.
- Keeping CF Access in front of `/call` — API keys + audit already gate it; add Access later if a key leaks.

## Open questions

- Request duration: gateway→container via DO binding should not hit Cloudflare's ~100 s origin cap, but `finance.cash_flow.refresh` chains several 60–120 s calls. Verify with a smoke on a real container before phase 2 cutover.
- D1 HTTP API from inside the container needs a CF API token in env. Alternative: core returns the audit row and the Worker writes it. Keep it in core unless the token scope turns out ugly.

## Consumer impact (asked 2026-10-12)

- Headless callers (n8n, rc-dashboards cron, Airtable contracts script) need NO config change: they keep sending `X-API-Key`; the stale `CF-Access-Client-*` headers are ignored (no Access app on the route, Worker/engine never read them). Clean up later or never.
- New keys/grants go live on deploy (~1 min) instead of within 60 s. Old container keeps serving during rollout.
- First call after 10 min idle waits 1–3 s for the container to wake. Raise `sleepAfter` if the team minds.
- MCP URL unchanged; Claude users do nothing.
