# Install Charter

Steps marked **[human]** need a browser or a secret paste and cannot be done by
an agent. Everything else is agent-executable.

## Prerequisites

- Python 3.10–3.12
- A Google Cloud project with BigQuery and Secret Manager enabled
- Claude Code, Claude Desktop, or another Claude surface that speaks remote MCP

## Step 1: Google OAuth client — created during gateway deployment

There's no separate client to create here. The Google **Web application**
OAuth client charter uses for actor identity is created as part of deploying
the gateway (`docs/deployment/gateway.md` step 1), and core's
`GOOGLE_OAUTH_CLIENT_ID` must be set to that same client id
(`docs/configuration.md` documents this).

**Cutover note:** if you're upgrading from the earlier stdio-based install,
delete its Desktop OAuth client in the Google Cloud console once the gateway
is live — nothing uses it after that install path is retired
(`docs/remote-mcp.md` §4.6 "Audience").

## Step 2: Install the package

Create and activate a virtualenv first — otherwise an ambient `uv`/`pip` may
resolve to the nearest project's environment and install there instead:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install "git+https://github.com/jasonrr/charter.git"
```

## Step 3: Configure environment

```bash
export GCP_PROJECT=your-project
export GOOGLE_OAUTH_CLIENT_ID=xxx.apps.googleusercontent.com
export ALLOWED_DOMAIN=@yourdomain.com
```

Optional: `PACKS=charter` to load the built-in reference packs (the default).

## Step 4: Mint your first key

`charter keys mint` is offline: it prints a random key and the `sha256:` JSON
fragment the engine matches it against.

```bash
charter keys mint --name test-agent --allow "data.*,identity.*" --require-actor
```

`--require-actor` marks the key so calls are rejected until a human signs in
(everything except `verbs.list`, which stays open so an agent can inspect its
toolbox first). That's what produces the `actor_required` you'll see in Step 5.

Store the fragment where the engine reads keys — either of:

- **Secret Manager** (the production path): put the fragment JSON in the
  `charter-keys` secret (name configurable via `KEYS_SECRET_NAME`):

  ```bash
  charter keys mint --name test-agent --allow "data.*,identity.*" --require-actor \
    | sed -n '/^{/,$p' > /tmp/keys.json
  gcloud secrets create charter-keys --data-file=/tmp/keys.json
  ```

  Later keys: `charter keys add` writes new versions of the secret directly.

- **`CHARTER_KEYS` env var** (local dev): export the fragment JSON as
  `CHARTER_KEYS`. It's the cold-start fallback when the Secret Manager fetch
  fails, so a laptop boot without the secret works — after one failed lookup
  logged at startup. That first failed lookup is logged at `ERROR`, then cached:
  it returns in a second or two if the project rejects the request (a placeholder
  `GCP_PROJECT` gives a fast permission error), or up to ~60s if the project is
  genuinely unreachable at the network level. Either way it's expected.

Save the raw key itself — it is shown once and never stored.

An API key is the headless path. A human signing in via OAuth with no key
needs a grant instead — see `docs/deployment/grants.md` for creating the
`charter-grants` secret; without it, an OAuth'd human with no key gets
`unauthorized` (401).

## Step 5: Verify the engine (agent-executable)

Start the engine:

```bash
functions-framework --target=bridge --source=src/charter/main.py --debug
```

`--debug` runs the single-process dev server. Use it for all local dev: the
default (forking) server crashes on macOS the first time an authenticated call
starts the gRPC-based Secret Manager client and a worker then forks — a macOS
objc fork-safety abort that surfaces, misleadingly, as a worker `SIGKILL` /
"out of memory". Production (Cloud Run on Linux) is unaffected.

Call it without a key — auth must fail closed:

```bash
curl -s -X POST http://localhost:8080 \
  -H "Content-Type: application/json" \
  -d '{"verb": "verbs.list"}'
```

Expected: `{"ok": false, "error": "unauthorized", ...}` (HTTP 401).

Now with the key from Step 4:

```bash
curl -s -X POST http://localhost:8080 \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <your-key>" \
  -d '{"verb": "verbs.list"}'
```

Expected: `ok: true` and a catalog of verbs (`verbs.list` is available to any
authenticated caller regardless of scope).

```bash
curl -s -X POST http://localhost:8080 \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <your-key>" \
  -d '{"verb": "identity.whoami"}'
```

Expected: `actor_required` — correct at this stage; no human actor has signed
in yet. Identity comes from the gateway sign-in in Step 7.

With a placeholder `GCP_PROJECT`, the engine terminal also logs `audit write
failed … Not found` on each call. That's harmless — auditing fails open, so the
response is still correct — and it clears once `GCP_PROJECT` points at a real
project with the audit table.

For a real deployment (Cloud Run behind Cloudflare Access), see
`docs/deployment/gcp-cloud-run.md`.

## Step 6: Install the Claude Code plugin

```bash
claude plugin marketplace add jasonrr/charter
claude plugin install charter@charter
```

One configuration value: `gateway_url` — your charter-gateway origin (from
`docs/deployment/gateway.md`). No credential is pasted; sign-in happens in
the browser on first use.

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
