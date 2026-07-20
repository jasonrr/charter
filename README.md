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
