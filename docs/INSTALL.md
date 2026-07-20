# Install Charter

Steps marked **[human]** need a browser or a secret paste and cannot be done by
an agent. Everything else is agent-executable.

## Prerequisites

- Python 3.10–3.12
- Node.js ≥ 18 (for the MCP proxy only)
- A Google Cloud project with BigQuery and Secret Manager enabled
- Claude Code (for the plugin) or Claude Desktop (for the `.mcpb` extension)

## Step 1: Create your Google OAuth client — [human]

1. Go to https://console.cloud.google.com/apis/credentials
2. Click **Create Credentials** → **OAuth client ID** → **Desktop app**
3. Name it "charter-identity"
4. Copy the **Client ID** and **Client secret** — you'll need both

This client is used only for actor identity (openid email scope). It grants no
access to Gmail, Drive, or other Google APIs.

## Step 2: Install the package

```bash
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
charter keys mint --name test-agent --allow "data.*,identity.*"
```

Store the fragment where the engine reads keys — either of:

- **Secret Manager** (the production path): put the fragment JSON in the
  `charter-keys` secret (name configurable via `KEYS_SECRET_NAME`):

  ```bash
  charter keys mint --name test-agent --allow "data.*,identity.*" \
    | sed -n '/^{/,$p' > /tmp/keys.json
  gcloud secrets create charter-keys --data-file=/tmp/keys.json
  ```

  Later keys: `charter keys add` writes new versions of the secret directly.

- **`CHARTER_KEYS` env var** (local dev): export the fragment JSON as
  `CHARTER_KEYS`. It's the cold-start fallback when the Secret Manager fetch
  fails, so a laptop boot without the secret works — after one failed lookup
  logged at startup.

Save the raw key itself — it is shown once and never stored.

## Step 5: Verify the engine (agent-executable)

Start the engine:

```bash
functions-framework --target=bridge --source=src/charter/main.py
```

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
in yet. Identity comes from the proxy in Step 6.

For a real deployment (Cloud Run behind Cloudflare Access), see
`docs/deployment/gcp-cloud-run.md`.

## Step 6: Install the Claude Code plugin

```bash
claude plugin marketplace add jasonrr/charter
claude plugin install charter@charter
```

Claude Code prompts for the plugin configuration:

- `charter_url`: your bridge URL (e.g. `http://localhost:8080` from Step 5, or
  your deployed URL)
- `credential` — **[human]**: paste your credential. Format
  `cf-client-id:cf-client-secret:api-key` behind Cloudflare Access; a bare
  API key otherwise. Never relay this through an agent.
- `google_client_id` / `google_client_secret` — **[human]**: from Step 1.
- `domain_hint`, `hubspot_client_id`: optional.

Claude Desktop instead: run `./desktop-extension/build.sh`, then double-click
the built `charter.mcpb` and enter the same values — **[human]**.

## Step 7: End-to-end verify through the proxy

In a Claude Code conversation, in order:

1. Ask for **`verbs.list`** (the `charter_read` tool). Expected: the catalog —
   proves URL, credential, and key scope.
2. Run **`charter_login`** — **[human]**: a browser opens for Google OAuth
   consent; sign in with an `ALLOWED_DOMAIN` address.
3. Ask for **`identity.whoami`**. Expected: your email and `is_human: true` —
   the `actor_required` from Step 5 is gone.
4. Call one read verb from your pack's domain (e.g. `data.warehouse.schema`).
   Expected: real data, and an audit row attributing the call to you.

If step 1 fails, the problem is credential/URL; if step 3 fails, it's the
OAuth client or domain allow-list. The steps isolate the failure layer.
