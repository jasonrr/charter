# Charter

Governed verb API for AI agents — audited, permissioned, actor-identified verbs
with embedded business logic.

## What it is

Most AI-to-system integration is either raw API access (dangerous, ungoverned) or
rigid configuration (can't express business logic). Charter is the middle path:
**verbs** — named, typed, permissioned operations with human-readable contracts,
audit trails, and actor identity. A verb is a function with a name like
`data.warehouse.query` or `airtable.batch_update`, registered by a **pack**
(adapter module), dispatched by the engine, and called by an AI agent through
an MCP proxy.

Charter runs in production at [Radical Candor](https://www.radicalcandor.com),
which consumes this public engine plus a private pack of its own verbs — the
same boundary any adopter would use.

## Why not the vendor's MCP server?

Vendor MCP servers solve connectivity: they get an agent talking to one API.
They don't solve governance. The agent holds a token, and it can do whatever
that token can do — every object, every destructive operation, attributed to
whichever account minted it. Charter puts a governed layer in between:

- **Scoped permission, not token permission.** Each agent gets its own key
  with an allow-list of named verbs (`--allow "data.*"`). An analytics agent
  can query the warehouse; it cannot touch CRM records, no matter what the
  underlying credentials allow.
- **Verbs, not raw CRUD.** A vendor server exposes the API surface and trusts
  the agent to reconstruct your business rules on every call. A Charter verb
  ships the rules inside it — validation, guardrails, side effects — so the
  agent can only do the operation the right way.
- **An audit trail you own.** Every call is recorded — agent, human actor,
  verb, target, result — in an append-only log in your warehouse. Keys can
  require a verified human actor, so "the agent did it" always resolves to a
  person. Irreversible verbs fail closed: if the audit write fails, the
  action doesn't happen.
- **Instant revocation.** Keys are read live from Secret Manager — revoke one
  and it's dead within a minute, no redeploy, no rotating a shared vendor
  token out of every install that holds it.
- **One surface.** One proxy and one curated verb vocabulary across all your
  systems, instead of a server per vendor, each dumping dozens of tools into
  the agent's context.

## Install

```bash
pip install "git+https://github.com/jasonrr/charter.git"
```

(Pin to a commit SHA — `...charter.git@<sha>` — for reproducible deploys.)

Or from a local checkout:

```bash
git clone https://github.com/jasonrr/charter.git
cd charter
pip install -e ".[dev]"
```

## Quick Start

Set required environment variables:

```bash
export GCP_PROJECT=your-gcp-project
export GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
export ALLOWED_DOMAIN=@yourdomain.com
```

Run the engine locally:

```bash
functions-framework --target=bridge --source=src/charter/main.py
```

Or deploy to Cloud Run using the included `deploy/service.yaml` template.

Mint an API key for an agent:

```bash
charter keys mint --name my-agent --allow "data.*"
```

## Architecture

- **Engine** (`charter.main.bridge`): HTTP entry point. Validates actor, checks permissions, audits, dispatches to the right handler.
- **SDK** (`charter.sdk`): Five primitives for pack authors. Small, typed, agent-legible.
- **Packs** (`charter.packs.*`): Reference adapters (BigQuery warehouse queries, Airtable batch updates). You write your own for your stack.
- **Conformance** (`charter.packtest`): Agent-runnable contract suite. Your coding agent runs this to verify its pack works.
- **Proxy** (`plugin/proxy/charter_mcp.js`): stdio MCP server. Claude Desktop / Claude Code plugin. Zero dependencies.

## Configuration

See [`docs/configuration.md`](docs/configuration.md) for the full env-var table.

| Variable | Required | Description |
|---|---|---|
| `GCP_PROJECT` | Yes | GCP project for BigQuery, Secret Manager |
| `GOOGLE_OAUTH_CLIENT_ID` | Yes | Google OAuth client ID for actor identity |
| `ALLOWED_DOMAIN` | Yes | Email domain allowed for actor sign-in |
| `PACKS` | No | Comma-separated list of pack distributions to load |

## License

Apache-2.0 — see [LICENSE](LICENSE).
