# Deploy on Cloudflare only

This page deploys the whole of Charter with one Cloudflare account. You need no
GCP project. Three Cloudflare products do the work:

- **Workers** runs the gateway (sign-in, MCP, and `POST /call`).
- **Containers** runs the core (the Python engine) in the same deploy.
- **D1** stores the audit log.

The gateway starts the core container on the first request. The container
sleeps after 10 minutes with no traffic.

## 1. Prerequisites

- A Cloudflare account on the **Workers Paid** plan ($5 per month). Containers
  need this plan.
- Docker, running on your computer. Wrangler builds the core image locally.
- Node 20 or later.
- Python 3.10, 3.11 or 3.12, for the `charter keys` command.

Log in to Cloudflare:

```bash
cd gateway
npm ci
npx wrangler login
```

## 2. Google Web OAuth client

Create the Google **Web application** OAuth client as described in
[`gateway.md`](gateway.md) step 1. Keep the client id and the client secret.
You use them in step 6.

## 3. KV namespace and D1 database

Run these from `gateway/`.

```bash
npx wrangler kv namespace create OAUTH_KV
```

Copy the `id` from the output into the `kv_namespaces` entry in
`gateway/wrangler.jsonc`.

```bash
npx wrangler d1 create charter-audit
```

Write down the `database_id` from the output. Step 4 uses it. Then create the
audit table:

```bash
npx wrangler d1 execute charter-audit --remote --file ../sql/audit_table.d1.sql
```

## 4. API token for the audit log

The core container writes audit rows to D1 through the Cloudflare API. It needs
a token.

1. In the Cloudflare dashboard, open **My Profile**, then **API Tokens**, then
   **Create Token**, then **Create Custom Token**.
2. Add one permission: **Account**, **D1**, **Edit**.
3. Under **Account Resources**, choose your account only.
4. Create the token and copy it.

Store it as a secret:

```bash
npx wrangler secret put CORE_CF_API_TOKEN
```

In `gateway/wrangler.jsonc`, add these two values to `vars`:

```jsonc
"CORE_CF_ACCOUNT_ID": "8f3a1c0d2b4e5f60718293a4b5c6d7e8",   // the long hex string in your dashboard URL
"CORE_CF_D1_DATABASE_ID": "b2c4e6a8-1d3f-4a5b-9c7e-0f1a2b3c4d5e" // database_id from step 3
```

This token can also delete rows from the `audit` table. BigQuery's insert-only
path has no such risk. On Cloudflare, the audit log is as safe as the token is
protected. If you need a copy that nobody can change, export the table on a
schedule, for example with `npx wrangler d1 export charter-audit --remote
--output audit.sql`.

## 5. API key and grants

Run these from the repository root, in a Python virtualenv:

```bash
python3.11 -m venv .venv && source .venv/bin/activate
pip install "git+https://github.com/jasonrr/charter.git"
```

Make a key. The command needs only the `CHARTER_BACKEND` variable:

```bash
CHARTER_BACKEND=cloudflare charter keys add --name first-agent --allow "verbs.*,identity.*"
```

The command writes `charter-keys.json` (file mode 0600). The file holds only
the `sha256:` digest of the key. The command prints the plain key one time.
Copy it now. Example output:

```text
wrote charter-keys.json. Push it with: npx wrangler secret put CORE_CHARTER_KEYS < charter-keys.json
Added key for first-agent (digest: sha256:9f2c…)
  Key (save this — it will not be shown again): Qk3v…
```

Push the file as a secret:

```bash
cd gateway
npx wrangler secret put CORE_CHARTER_KEYS < ../charter-keys.json
```

Next, make the grants file. It says which verbs each person can call after
Google sign-in (see [`grants.md`](grants.md)). From the repository root:

```bash
cat > charter-grants.json <<'JSON'
{"you@example.com": {"allow": ["verbs.*", "identity.*"]}}
JSON
cd gateway
npx wrangler secret put CORE_CHARTER_GRANTS < ../charter-grants.json
```

Replace `you@example.com` with your own address. Git ignores both files. Do not
commit them.

## 6. Gateway configuration

Set these in `gateway/wrangler.jsonc`, under `vars`. They are the same as in
[`gateway.md`](gateway.md) step 4, with these changes: `CF_ACCESS_CLIENT_ID`,
`CF_ACCESS_CLIENT_SECRET` and `CHARTER_CORE_URL` are for a GCP origin. Do not
set them here.

| Variable | Example | Note |
|---|---|---|
| `CHARTER_ALLOWED_DOMAIN` | `@example.com` | Domain suffix for sign-in |
| `GOOGLE_CLIENT_ID` | `123-abc.apps.googleusercontent.com` | From step 2. The gateway also gives it to the core |
| `CHARTER_GATEWAY_URL` | `https://charter.example.com` | The gateway's own https origin. Required |
| `CHARTER_EXTRA_REDIRECT_ORIGINS` | `""` | Optional |
| `CHARTER_INSTRUCTIONS` | (unset) | Optional |
| `CHARTER_CONNECT_PROVIDERS` | (unset) | Optional |

Set these secrets:

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put OAUTH_STATE_SECRET      # for example: openssl rand -base64 32
```

Set `CHARTER_API_KEY` only if `gateway.md` says you need it. Normally leave it
unset.

The core container reads its settings from every Worker variable and secret
whose name starts with `CORE_`. Wrangler removes the prefix. `CORE_PACKS`
becomes `PACKS` inside the container. The gateway also sets
`CHARTER_BACKEND=cloudflare` and `GOOGLE_OAUTH_CLIENT_ID` for the container, so
you do not set them.

Core variables, in `vars`:

```jsonc
"CORE_ALLOWED_DOMAIN": "@example.com",                   // same value as CHARTER_ALLOWED_DOMAIN
"CORE_CHARTER_GATEWAY_URL": "https://charter.example.com", // same value as CHARTER_GATEWAY_URL
"CORE_PACKS": "charter"
```

The gateway and the core each read their own copy, so set both. If you change
one, change the other.

Core secrets (you set the first three in steps 4 and 5):

- `CORE_CHARTER_KEYS`
- `CORE_CHARTER_GRANTS`
- `CORE_CF_API_TOKEN`

A pack setting from [`../configuration.md`](../configuration.md) "Pack-specific"
goes in as `CORE_<NAME>`. Example: `"CORE_WAREHOUSE_DATASETS": "sales,support"`.

## 7. Deploy

Docker must be running.

```bash
npx wrangler deploy
```

Wrangler builds the core image, pushes it, and publishes the Worker. Note the
Worker URL in the output. If it is not the value you put in
`CHARTER_GATEWAY_URL` (and `CORE_CHARTER_GATEWAY_URL`), fix both values and run
`npx wrangler deploy` again. Sign-in refuses to run when they do not match.

After the first deploy, wait a few minutes before the first call. Cloudflare
needs this time to prepare the container.

To check the configuration without building the image, run
`npx wrangler deploy --dry-run --containers-rollout=none`. Without
`--containers-rollout=none`, a dry run builds the image and needs Docker.

## 8. Smoke test

```bash
curl -s -X POST https://charter.example.com/call \
  -H 'X-API-Key: Qk3v…' \
  -H 'Content-Type: application/json' \
  -d '{"verb":"verbs.list"}'
```

Expected: `"ok": true` and a list of verbs. Then read the audit row:

```bash
npx wrangler d1 execute charter-audit --remote \
  --command "select ts, actor, verb, result from audit order by ts desc limit 3"
```

Expected: a row with `verb` = `verbs.list` and the name of your key as `actor`.

What `/call` does:

- It accepts `POST` only. Other methods get `405`.
- It needs the `X-API-Key` header. Without it, the answer is `401`.
- It accepts a request body of 1 MiB at most. A larger body gets `413`.
- It sends only `X-API-Key` and `traceparent` to the core.
- It returns the core's `Content-Type` and `Retry-After` headers.
- If the core container cannot answer, you get `502` with the error
  `core_unavailable`.

Long verbs: measured ceiling recorded after the live smoke test.

## 9. Operations

**Rotate a secret.** Run `npx wrangler secret put CORE_CHARTER_KEYS` (or any
other `CORE_` secret). The next request starts a new container with the new
values, which takes 1 to 3 seconds. From that request on, the old key does not
work. To revoke a key, run `CHARTER_BACKEND=cloudflare charter keys revoke
--name first-agent`, then push the file again.

**Cold start.** After 10 minutes with no requests, the container sleeps. The
next request takes 1 to 3 seconds longer.

**Audit table.** `AUDIT_TABLE` does not apply here. The D1 table is always
named `audit`.

**Protect `/call`.** The gateway cannot tell a valid key from a wrong one, and
each wrong request can wake the container, which you pay for. Add a rate limit
in the dashboard: **Security**, **WAF**, **Rate limiting rules**. Example: when
the URI path equals `/call`, allow 60 requests per minute for each IP address.

## 10. What stays on GCP

Nothing stays on GCP for the engine. Verb results are always sent inline; the
`RESULTS_BUCKET` offload is off. The reference `bigquery` and `gdrive` packs
read Secret Manager and Application Default Credentials. They work in GCP mode
only.
