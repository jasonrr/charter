# Remote-MCP Sub-project D: Distribution Repackage + Proxy Removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the stdio proxy and `.mcpb` desktop extension, convert the Claude Code plugin to a remote-HTTP pointer at the gateway, and rewrite the four docs that describe the old distribution model.

**Architecture:** Sub-project D of `docs/remote-mcp.md` (§6, §7.1). The gateway (sub-project B, landed on `feat/gateway`) replaces the proxy outright — no soft-deprecation, no migration (no external adopters, §7.1). The plugin keeps its skills and becomes a `{"type": "http"}` MCP pointer; OAuth happens client-driven against the gateway, so the entire `user_config` secret form disappears except the gateway URL.

**Tech Stack:** JSON plugin manifests, Markdown docs. No Python or TypeScript changes.

## Global Constraints

- Branch: `feat/gateway` (D is part of B's release — §4.6: repointing core's `GOOGLE_OAUTH_CLIENT_ID` to the gateway's Web client breaks the proxy, so B and D ship together).
- **Pre-existing uncommitted state is absorbed, not preserved:** `README.md` (+1 line linking distribution.md), `docs/INSTALL.md` (+3 lines), and untracked `docs/distribution.md` are all rewritten wholesale by Tasks 3–4. Do not try to keep those edits; they describe the model this plan deletes.
- Verification norm (from the spec's Sources discipline): any claim about Claude Code plugin schema or MCP client behavior must be checked against live docs (code.claude.com/docs / modelcontextprotocol.io), not memory.
- Commit per task; do not push.
- The two skills `plugin/skills/using-verbs.md` and `plugin/skills/pack-authoring.md` survive — they are the plugin's payload now.

---

### Task 1: Delete `plugin/proxy/` and `desktop-extension/`

**Files:**
- Delete: `plugin/proxy/charter_mcp.js` (657 lines)
- Delete: `desktop-extension/build.sh`, `desktop-extension/manifest.json`, `desktop-extension/charter.mcpb` (the whole directory)

**Interfaces:**
- Consumes: nothing.
- Produces: their absence. Later tasks remove every reference; this task only verifies no *code or CI* depends on the deleted paths.

- [ ] **Step 1: Confirm nothing outside docs references the deleted paths**

Run:
```bash
grep -rn "charter_mcp\|desktop-extension\|\.mcpb" --exclude-dir=node_modules --exclude-dir=.git . \
  | grep -v -E "^\./(docs/|README|plugin/proxy/|desktop-extension/|\.superpowers/)"
```
Expected: only hits inside `plugin/.mcp.json` and `plugin/.claude-plugin/plugin.json` (fixed in Task 2). Any other hit (CI, scripts, gateway code) is a stop condition — investigate before deleting.

- [ ] **Step 2: Delete**

```bash
git rm -r plugin/proxy desktop-extension
```

- [ ] **Step 3: Verify both suites still pass**

```bash
PYTHONPATH=src .venv/bin/python -m pytest -q          # expect: all pass
cd gateway && npx vitest run && npx tsc --noEmit       # expect: all pass, clean
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(distribution)!: remove the stdio proxy and .mcpb desktop extension

The gateway (docs/remote-mcp.md §7.1) replaces both outright; no external
adopters exist to migrate."
```

---

### Task 2: Convert the plugin to a remote-HTTP pointer

**Files:**
- Modify: `plugin/.claude-plugin/plugin.json` (replace `mcpServers` + `userConfig`)
- Modify: `plugin/.mcp.json` (replace wholesale)
- Modify: `plugin/skills/using-verbs.md:3` (proxy → gateway wording)

**Interfaces:**
- Consumes: gateway serving MCP at `<gateway-origin>/mcp` (sub-project B).
- Produces: a plugin whose only user configuration is `gateway_url` (non-secret). Tasks 3–4 document exactly this shape.

- [ ] **Step 1: Verify the plugin schema against live docs**

Fetch the Claude Code plugin docs (code.claude.com/docs — plugins/MCP config reference) and confirm: (a) `"type": "http"` MCP server entries are supported in plugin `.mcp.json`, and (b) `${user_config.*}` interpolation works in the `url` field. The reference shape is PostHog's `{"type": "http", "url": "https://mcp.posthog.com/mcp"}` (cited in `docs/remote-mcp.md` Sources). If (b) is unsupported, stop and record the fallback: hardcode nothing; instead document `claude mcp add --transport http charter <url>/mcp` as the install path and strip `mcpServers` from the plugin entirely (skills-only plugin). Note which branch was taken in the commit message.

- [ ] **Step 2: Replace both manifests**

`plugin/.claude-plugin/plugin.json`:
```json
{
  "$schema": "https://anthropic.com/claude-code/plugin.schema.json",
  "name": "charter",
  "version": "0.2.0",
  "description": "Charter — governed verb API for AI agents. Audited, permissioned, actor-identified verbs with embedded business logic. Points your client at a charter-gateway deployment; sign-in is Google OAuth in the client, no pasted secrets.",
  "author": {
    "name": "Charter Contributors"
  },
  "mcpServers": {
    "charter": {
      "type": "http",
      "url": "${user_config.gateway_url}/mcp"
    }
  },
  "userConfig": {
    "gateway_url": {
      "type": "string",
      "title": "Charter gateway URL",
      "description": "Origin of your charter-gateway deployment (e.g. https://charter-gw.example.com). Sign-in happens in your browser via Google; no credential is pasted here.",
      "required": true
    }
  }
}
```

`plugin/.mcp.json`:
```json
{
  "mcpServers": {
    "charter": {
      "type": "http",
      "url": "${user_config.gateway_url}/mcp"
    }
  }
}
```

- [ ] **Step 3: Update the skill's transport sentence**

In `plugin/skills/using-verbs.md` line 3, replace
`How to interact with a charter bridge through the MCP proxy.` with
`How to interact with a charter deployment through its gateway (remote MCP).`
Skim the rest of both skill files for `proxy` / `charter_login` / `charter_connect_hubspot` mentions; the surviving tool surface is `charter_read` and `charter_call` only (§4.2). Fix any stale tool names found.

- [ ] **Step 4: Validate JSON**

```bash
python3 -m json.tool plugin/.claude-plugin/plugin.json > /dev/null && \
python3 -m json.tool plugin/.mcp.json > /dev/null && echo OK
```
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add plugin
git commit -m "feat(distribution): plugin becomes a remote-HTTP pointer carrying skills

One non-secret config value (gateway_url) replaces the six-field secret form;
OAuth is client-driven against the gateway (docs/remote-mcp.md §4.3)."
```

---

### Task 3: Rewrite `docs/distribution.md`

**Files:**
- Modify: `docs/distribution.md` (replace wholesale — the untracked 143-line version on disk describes the proxy + `.mcpb` model and is stale by §7.1)

**Interfaces:**
- Consumes: Task 2's plugin shape (`gateway_url`, skills payload).
- Produces: the doc Task 4's README/INSTALL links point at.

- [ ] **Step 1: Replace the file with the gateway-era model**

```markdown
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
```

- [ ] **Step 2: Check internal links resolve**

```bash
ls docs/remote-mcp.md docs/INSTALL.md docs/deployment/grants.md
```
Expected: all exist.

- [ ] **Step 3: Commit**

```bash
git add docs/distribution.md
git commit -m "docs(distribution): rewrite for the gateway model, dropping proxy/.mcpb"
```

---

### Task 4: Rewrite `README.md` and `docs/INSTALL.md` references

**Files:**
- Modify: `README.md:14` (transport sentence), `README.md:107` (components list — the line with the pre-existing uncommitted edit; both versions die here)
- Modify: `docs/INSTALL.md` steps 1, 6, 7

**Interfaces:**
- Consumes: Task 3's `distribution.md`; the gateway runbook `docs/deployment/gateway.md`.
- Produces: install/readme text with zero `proxy` / `.mcpb` / `charter_login` references.

- [ ] **Step 1: README edits**

Line 14: replace `an MCP proxy.` with `remote MCP (the charter gateway).`
Line 107 (currently the `- **Proxy** ...` bullet, including the uncommitted trailing sentence): replace with
```markdown
- **Gateway** (`gateway/`): remote MCP server (Streamable HTTP + OAuth) that
  translates to the engine. How it is deployed and how charter is
  distributed: [`docs/deployment/gateway.md`](docs/deployment/gateway.md),
  [`docs/distribution.md`](docs/distribution.md).
```

- [ ] **Step 2: INSTALL.md — Step 1 repoint**

Step 1 ("Create your Google OAuth client") currently produces the Desktop
client the proxy used. Replace its body with a pointer: the Google **Web
application** client is created during gateway deployment
(`docs/deployment/gateway.md` step 2), and core's `GOOGLE_OAUTH_CLIENT_ID`
must be set to that same client id (`configuration.md` documents this). Add
the cutover note: **the old Desktop OAuth client should be deleted in the
Google Cloud console once the gateway is live** — nothing uses it after the
proxy's removal (`remote-mcp.md` §4.6 "Audience").

- [ ] **Step 3: INSTALL.md — Steps 6–7 replacement**

Replace Step 6 (plugin install with six config values + `.mcpb` paragraph) with:
```markdown
## Step 6: Install the Claude Code plugin

```bash
claude plugin marketplace add jasonrr/charter
claude plugin install charter@charter
```

One configuration value: `gateway_url` — your charter-gateway origin (from
`docs/deployment/gateway.md`). No credential is pasted; sign-in happens in
the browser on first use.
```

Replace Step 7 ("End-to-end verify through the proxy") with:
```markdown
## Step 7: End-to-end verify through the gateway

In a Claude Code conversation, in order:

1. On first tool use, the client opens the gateway's consent page, then
   Google sign-in — **[human]**: use an `ALLOWED_DOMAIN` address that has a
   grant (`docs/deployment/grants.md`).
2. Ask for **`verbs.list`** (the `charter_read` tool). Expected: the catalog
   filtered to your grant — proves gateway URL, OAuth, and grants end-to-end.
3. Ask for **`identity.whoami`**. Expected: your email and `is_human: true`.
4. Call one read verb from your pack's domain (e.g. `data.warehouse.schema`).
   Expected: real data, and an audit row naming you as the caller
   (`interface: "oauth"`).

If step 1 fails, the problem is the gateway deployment or its Google client;
if step 2 returns nothing, your email has no grant; the steps isolate the
failure layer.
```

- [ ] **Step 4: Sweep for leftovers**

```bash
grep -rn -i "proxy\|mcpb\|charter_login\|charter_connect_hubspot\|CHARTER_CREDENTIAL" README.md docs/INSTALL.md
```
Expected: no hits (historical mentions inside `docs/remote-mcp.md` and the runbooks are allowed and out of scope).

- [ ] **Step 5: Commit**

```bash
git add README.md docs/INSTALL.md
git commit -m "docs(install): gateway install path replaces proxy + .mcpb instructions"
```

---

### Task 5: `docs/configuration.md` — retire the proxy section

**Files:**
- Modify: `docs/configuration.md` (the `## Proxy-specific (plugin / MCPB)` section, lines ~27–38)

**Interfaces:**
- Consumes: Task 2's single `gateway_url` config value.
- Produces: a config reference with no dead rows.

- [ ] **Step 1: Replace the section**

Replace the whole `## Proxy-specific (plugin / MCPB)` section (heading, intro
sentence, and six-row table: `charter_url`, `credential`, `google_client_id`,
`google_client_secret`, `domain_hint`, `hubspot_client_id`) with:

```markdown
## Plugin (interactive install)

One value, set when installing the Claude Code plugin:

| Key | Required | Description |
|---|---|---|
| `gateway_url` | Yes | Origin of your charter-gateway deployment; the plugin points MCP at `<gateway_url>/mcp`. Not a secret. |

Gateway deployment variables (`CHARTER_GATEWAY_URL`, `CF_ACCESS_CLIENT_ID`,
`CF_ACCESS_CLIENT_SECRET`, `OAUTH_STATE_SECRET`, …) are documented in
[`deployment/gateway.md`](deployment/gateway.md).
```

Leave the `GOOGLE_OAUTH_CLIENT_ID` row (line ~10) as is — it already
describes the gateway-era repoint correctly.

- [ ] **Step 2: Verify no orphaned references**

```bash
grep -n "charter_url\|credential\b\|domain_hint" docs/configuration.md
```
Expected: no hits from the deleted table.

- [ ] **Step 3: Commit**

```bash
git add docs/configuration.md
git commit -m "docs(configuration): one gateway_url row replaces the proxy secret table"
```

---

### Task 6: Cutover checklist in the gateway runbook

**Files:**
- Modify: `docs/deployment/gateway.md` (append a short section; read the file's structure first and place it after the verification section)

**Interfaces:**
- Consumes: everything above.
- Produces: the operator's one-screen D cutover procedure.

- [ ] **Step 1: Append the cutover section**

```markdown
## Cutover from the stdio proxy (one-time)

Ships with the release that removes `plugin/proxy/` (`remote-mcp.md` §7.1).
In order:

1. Deploy the gateway; verify per this runbook.
2. Set core's `GOOGLE_OAUTH_CLIENT_ID` to the gateway's Web application
   client id and redeploy core (`remote-mcp.md` §4.6 "Audience"). From this
   moment the old proxy cannot verify actors — expected, there are no
   adopters on it.
3. Populate `charter-grants` for every interactive human
   (`deployment/grants.md`); an empty grants file is a locked-out
   deployment, not a permissive one.
4. Delete the old Google **Desktop** OAuth client in the Cloud console.
5. Update the installed plugin (`claude plugin install charter@charter`);
   verify per `INSTALL.md` step 7.
```

- [ ] **Step 2: Commit**

```bash
git add docs/deployment/gateway.md
git commit -m "docs(gateway): one-time proxy cutover checklist"
```

---

## Self-Review Notes

- Spec coverage: §6-D's four clauses map to Task 1 (delete), Task 2 (remote-HTTP pointer carrying skills), Tasks 3–4 (INSTALL/distribution rewrite), plus Task 5–6 absorbing the two known-open doc items (`configuration.md` credential row; §4.6 Desktop-client retirement). The third known-open item folded in: INSTALL step 7's rewrite removes the `charter_login` flow that no longer exists.
- The Task 2 Step 1 live-docs check is the plan's only external dependency; its fallback (skills-only plugin + `claude mcp add`) is specified, not deferred.
- Out of scope, deliberately: the `charter-keys` validation description in INSTALL step 4 (tracked separately in the handoff's known-open list); `identity.hs.connect` verb and HubSpot flow (§4.6, future sub-project).
