# Configuration

All engine configuration is via environment variables. No config files, no YAML.

## Required

| Variable | Type | Description |
|---|---|---|
| `GCP_PROJECT` | string | GCP project ID for BigQuery, Secret Manager, and Cloud Run |
| `GOOGLE_OAUTH_CLIENT_ID` | string | Google OAuth client ID for actor identity verification |
| `ALLOWED_DOMAIN` | string | Email domain suffix allowed for actor sign-in (e.g. `@example.com`) |

## Optional

| Variable | Default | Description |
|---|---|---|
| `PACKS` | `charter` | Comma-separated list of pack distributions to load via entry-point discovery |
| `KEYS_SECRET_NAME` | `charter-keys` | Secret Manager secret holding API keys |
| `GRANTS_SECRET_NAME` | `charter-grants` | Secret Manager secret holding the email→allow grants map |
| `CHARTER_GRANTS` | (empty) | Grants JSON, cold-start fallback if Secret Manager is unreachable at boot |
| `GOOGLE_REFRESH_SECRET_NAME` | `charter-google-refresh` | Secret Manager secret holding Google refresh tokens |
| `AUDIT_TABLE` | `charter.audit` | BigQuery table for audit logs |
| `WAREHOUSE_DATASETS` | (empty) | Comma-separated list of BigQuery datasets exposed by `data.warehouse.*` |

## Proxy-specific (plugin / MCPB)

These are set via the plugin's `user_config` or manifest env keys:

| Key | Required | Description |
|---|---|---|
| `charter_url` | Yes | Bridge endpoint URL |
| `credential` | Yes | `cf-client-id:cf-secret:api-key` combined string |
| `google_client_id` | Yes | Your Google OAuth client ID |
| `google_client_secret` | Yes | Your Google OAuth client secret |
| `domain_hint` | No | Preferred email domain for Google sign-in hint |
| `hubspot_client_id` | No | HubSpot app client ID for HubSpot identity |

## Pack-specific

Packs read their own config through `get_config()`, not from engine env vars.
This keeps the engine's public env-var API small and stable.

| Pack | Config key | Description |
|---|---|---|
| BigQuery | `WAREHOUSE_DATASETS` | Datasets exposed (engine setting, shared) |
| Airtable | (pack-internal) | Airtable API key, base IDs, table IDs |
| HubSpot | (pack-internal) | HubSpot portal ID, OAuth tokens |
