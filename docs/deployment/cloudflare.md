# Deploy on Cloudflare only

This page deploys the whole of Charter with one Cloudflare account. The engine
uses no GCP service. One small exception: the Google sign-in client lives in a
free Google Cloud project (no billing, no APIs enabled). That project only hosts
the OAuth client. Three Cloudflare products do the work:

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
- A free Google Cloud project, to host the Google OAuth client (step 2).

Start in the repository root. Install the gateway and log in to Cloudflare:

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

Run these from `gateway/`. If Wrangler asks to add the binding to your config
file, answer no. You paste the id yourself.

```bash
cd gateway   # skip if you are already in gateway/
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

Store it as a secret. Before the first deploy, Wrangler offers to create the
Worker for the secret. Answer yes.

```bash
cd gateway   # skip if you are already in gateway/
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

Run these from the repository root. Install Charter from a clone, in a Python
virtualenv:

```bash
cd ..   # to the repository root; if you have no clone yet:
        # git clone https://github.com/jasonrr/charter.git && cd charter
python3.11 -m venv .venv && source .venv/bin/activate
pip install -e .
```

Make a key (still in the repository root). The command needs only the `CHARTER_BACKEND` variable:

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

`charter-keys.json` is the source of truth for the key map. Each `charter keys`
command changes this file. If you lose it, or start a new one and push it, all
earlier keys stop working. It holds only digests, so keep it safe, but it does
not hold a usable key.

Push the file as a secret:

```bash
cd gateway
npx wrangler secret put CORE_CHARTER_KEYS < ../charter-keys.json
```

Next, make the grants file. It says which verbs each person can call after
Google sign-in (see [`grants.md`](grants.md)). From the repository root:

```bash
cd ..   # to the repository root
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
set the two secrets here. Leave `CHARTER_CORE_URL` as it is in
`wrangler.jsonc`; it is ignored when the `CHARTER_CORE` binding exists.

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
cd gateway   # skip if you are already in gateway/
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put OAUTH_STATE_SECRET      # for example: openssl rand -base64 32
```

Set `CHARTER_API_KEY` only if `gateway.md` says you need it. Normally leave it
unset.

The core container reads its settings from every Worker variable and secret
whose name starts with `CORE_`. The gateway removes the prefix when it starts
the container. `CORE_PACKS` becomes `PACKS` inside the container. The gateway also sets
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
goes in as `CORE_<NAME>`, with `<NAME>` the setting's name in that table.
Use a variable for a plain value and a secret for a token. The reference
`bigquery` and `gdrive` packs work in GCP mode only (section 10).

## 7. Deploy

Docker must be running.

```bash
cd gateway   # skip if you are already in gateway/
npx wrangler deploy
```

Wrangler builds the core image, pushes it, and publishes the Worker. Note the
Worker URL in the output, for example
`https://charter-gateway.acme.workers.dev`. If it is not the value you put in
`CHARTER_GATEWAY_URL` and `CORE_CHARTER_GATEWAY_URL`, do all three of these:

1. In the Google OAuth client, add `https://charter-gateway.acme.workers.dev/callback`
   to the authorized redirect URIs. Without it, sign-in fails with no clear
   error (see [`gateway.md`](gateway.md) step 1).
2. Set `CHARTER_GATEWAY_URL` and `CORE_CHARTER_GATEWAY_URL` to the real origin.
3. Run `npx wrangler deploy` again.

Sign-in refuses to run when the gateway URL does not match the real origin.

After the first deploy, wait before the first call: Cloudflare needs time to
prepare the container. In the live smoke test (2026-10-13) the first call got
Cloudflare error `1042` for about 10 seconds, then `200`.

To check the configuration without building the image, run
`npx wrangler deploy --dry-run --containers-rollout=none`. Without
`--containers-rollout=none`, a dry run builds the image and needs Docker.

## 8. Smoke test

```bash
# use your Worker URL, or your custom domain if you have one
curl -s -X POST https://charter-gateway.acme.workers.dev/call \
  -H 'X-API-Key: Qk3v…' \
  -H 'Content-Type: application/json' \
  -d '{"verb":"verbs.list"}'
```

Expected: `"ok": true` and a list of verbs. Then read the audit row:

```bash
cd gateway   # skip if you are already in gateway/
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

Long verbs: a verb that ran 150 seconds returned normally in the live smoke test (2026-10-13).

## 9. Operations

**Rotate a secret.** From `gateway/`, run `npx wrangler secret put CORE_CHARTER_KEYS`
(or any other `CORE_` secret). The next request starts a new container with
the new values. Cloudflare rolls the change out over about 30 seconds. During
that time a request can reach the old values or the new ones: the old key can
still work, the new key can get `401`, and a request can get
`502 core_unavailable` (retry it). After that, the old key gets `401` on every
request. Measured in the live smoke test (2026-10-13).

Wait 10 minutes between rotations. Each change of a `CORE_` value starts one
more container, and the old one runs until it has had no requests for 10
minutes. `max_instances` in `wrangler.jsonc` is 3. If a fourth set of values
goes live before an old container sleeps, every `/call` gets
`502 core_unavailable` until one does. No request reaches a container with the
old values.

**Revoke a key.** From the repository root, with the virtualenv active:

```bash
CHARTER_BACKEND=cloudflare charter keys revoke --name first-agent
cd gateway
npx wrangler secret put CORE_CHARTER_KEYS < ../charter-keys.json
```

**Cold start.** After 10 minutes with no requests, the container sleeps. The
next request takes longer: 2 to 4 seconds in the live smoke test (2026-10-13).

**Audit table.** `AUDIT_TABLE` does not apply here. The D1 table is always
named `audit`.

**Protect `/call`.** The gateway cannot tell a valid key from a wrong one, and
each wrong request can wake the container, which you pay for. Add a rate limit
in the dashboard: **Security**, **WAF**, **Rate limiting rules**. Example: when
the URI path equals `/call`, allow 60 requests per minute for each IP address.
WAF rules apply only to a custom domain in a zone you own. If you use only the
`workers.dev` address, you cannot add this rule; use a custom domain for the
gateway if you need it.

**API token for deploys.** If `CLOUDFLARE_API_TOKEN` is set in your shell,
Wrangler uses it instead of `wrangler login`. That token needs
**Account · Containers · Edit** too, or `wrangler deploy` stops with
`Unauthorized` after it builds the image.

**Remove a deployment.** `npx wrangler delete` removes the Worker but not its
container application or image. Remove those too:

```bash
cd gateway
npx wrangler delete
npx wrangler containers list                 # note the ID of <worker-name>-chartercore
npx wrangler containers delete <ID>
npx wrangler containers images list
npx wrangler containers images delete <repository>:<tag>
npx wrangler d1 delete charter-audit
npx wrangler kv namespace delete --namespace-id <OAUTH_KV id>
```

## 10. What stays on GCP

Nothing stays on GCP for the engine. Verb results are always sent inline; the
`RESULTS_BUCKET` offload is off. The reference `bigquery` and `gdrive` packs
read Secret Manager and Application Default Credentials. They work in GCP mode
only.
