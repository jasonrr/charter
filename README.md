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
remote MCP (the charter gateway).

Charter runs in production at [Radical Candor](https://www.radicalcandor.com),
which consumes this public engine plus a private pack of its own verbs — the
same boundary any adopter would use.

## Lean context, better agent performance

Governance is half the story. The other half is that your agent works *better*.

A vendor MCP server loads its entire tool catalog into the agent's context and
leaves it there — every tool, every turn. Connect five systems and the agent
wades through a hundred tool schemas on every call, spending tokens and
attention picking among them before it does any work. The cost grows with every
system you add.

Charter's context cost is constant: **two tools, no matter how many verbs or
systems sit behind them** — `charter_call` and `charter_read`. The agent
discovers verbs on demand by calling `verbs.list` (scoped to exactly what its
key allows), and the business rules ride inside each verb, so the agent doesn't
reconstruct — or guess wrong about — how an operation works. Less context spent
on tool sprawl, fewer wrong turns, more room for the task.

## Stateless by construction

The MCP spec's `2026-07-28` revision removed protocol-level sessions: no
`Mcp-Session-Id`, no `initialize` handshake, and servers that need cross-call
state are told to mint explicit handles and pass them as ordinary tool
arguments.

Charter's gateway was already built that way — a fresh server per request, no
Durable Object, no per-session state, and oversized results handed back as
`charter://result/<id>` handles. That was a simplicity decision before it was a
compliance one: a gateway that holds one credential and translates has nothing
to keep between calls. It means the revision that gives session-backed
deployments a migration gives charter nothing to do.

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
- **Gateway** (`gateway/`): remote MCP server (Streamable HTTP + OAuth) that
  translates to the engine. How it is deployed and how charter is
  distributed: [`docs/deployment/gateway.md`](docs/deployment/gateway.md),
  [`docs/distribution.md`](docs/distribution.md).

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
