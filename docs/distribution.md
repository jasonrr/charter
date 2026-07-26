# Distributing Charter

How charter reaches the people and agents that call it. One deployable pair
(gateway + core, `remote-mcp.md` §2), one plugin, no local artifacts.

## The shape

Interactive users add charter as a **remote MCP server**: the Claude Code
plugin carries two skills and a single pointer —
`{"type": "http", "url": "<gateway>/mcp"}` — configured with one non-secret
value, the operator's gateway URL. On first use the client runs OAuth against
the gateway, which federates Google (`remote-mcp.md` §4.3). Nothing is pasted,
nothing is stored on the user's machine, and every Claude surface that speaks
remote MCP (Code, Desktop, web, Cowork) is reached by the same pointer.

Headless agents (CI, cron) skip MCP entirely: they call core's HTTP API
directly with an admin-minted `X-API-Key` (`INSTALL.md` step 4), exactly as
`packtest` and the curl verification do.

## What the plugin carries

- `skills/using-verbs.md` — how to call `charter_read` / `charter_call`.
- `skills/pack-authoring.md` — how to write a pack.
- `.mcp.json` — the pointer above. No proxy process, no `user_config` secrets.

## How an update reaches an installed client

- **Verbs and packs:** deploy core; every `verbs.list` passes through live
  (the gateway caches nothing, `remote-mcp.md` §2.4). Clients see changes
  immediately.
- **Protocol/transport:** deploy the gateway. Clients reconnect; no
  client-side artifact to rebuild.
- **Skills:** plugin version bump; clients update the plugin.

The old model shipped two local artifacts (a stdio proxy and a `.mcpb`
extension) whose updates required every user to rebuild or reinstall. Both
were removed with the gateway release (`remote-mcp.md` §7.1).

## The tenant boundary

Single operator, single org (`remote-mcp.md` §7.2). The gateway URL *is* the
tenant: each adopter deploys their own gateway + core pair and hands out
their own URL. Scope per human comes from core's `charter-grants`
(`deployment/grants.md`); nothing tenant-specific lives in the plugin.
