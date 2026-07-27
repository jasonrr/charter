# Deploy on GCP Cloud Run

The included `deploy/service.yaml` is a Cloud Run service template with a
Cloudflare Access tunnel sidecar. It keeps one instance warm (`min-instances=1`)
to avoid cold-start latency for interactive agent calls.

## Prerequisites

- GCP project with Cloud Run, BigQuery, and Secret Manager APIs enabled
- Cloudflare Access tunnel configured (the `cloudflared` sidecar in the template)
- Artifact Registry docker repository

## Steps

1. Build the container:

```bash
gcloud builds submit . --tag us-central1-docker.pkg.dev/$PROJECT/cloud-run-source-deploy/charter:latest
```

2. Deploy the service:

```bash
gcloud run services replace deploy/service.yaml --region us-central1
```

3. Verify:

```bash
curl -X POST $(gcloud run services describe charter --region us-central1 --format 'value(status.url)') \
  -H "Content-Type: application/json" \
  -d '{"verb": "verbs.list"}'
```

## Results bucket (§4.5 payload offload)

Oversized verb results are offloaded to GCS and fetched back by reference
(`result.read`). One bucket, private, with a lifecycle rule doing the
expiry — core never deletes.

    gcloud storage buckets create gs://$PROJECT-charter-results \
      --project $PROJECT --location $REGION --uniform-bucket-level-access

    cat > /tmp/charter-results-lifecycle.json <<'EOF'
    {"rule": [{"action": {"type": "Delete"}, "condition": {"age": 1}}]}
    EOF
    gcloud storage buckets update gs://$PROJECT-charter-results \
      --lifecycle-file=/tmp/charter-results-lifecycle.json

    gcloud storage buckets add-iam-policy-binding gs://$PROJECT-charter-results \
      --member "serviceAccount:$RUNTIME_SA" --role roles/storage.objectAdmin

Then set `RESULTS_BUCKET=$PROJECT-charter-results` on the service. Leave it
unset to disable offload (results stay inline; the gateway truncates at 1 MB).

## Staging

A staging core is a second Cloud Run service from the same image — everything
that must differ is already an env var, so no code or template changes:

- Service name `charter-staging` (copy `deploy/service.yaml`, change
  `metadata.name`).
- `GOOGLE_OAUTH_CLIENT_ID` = the **staging** gateway's Web client id
  (`docs/deployment/gateway.md` "Staging") — this is what keeps staging tokens
  invalid at production core and vice versa.
- `KEYS_SECRET_NAME=charter-keys-staging`,
  `GRANTS_SECRET_NAME=charter-grants-staging`,
  `AUDIT_TABLE=charter.audit_staging` — staging never reads or writes a
  production secret or audit row.
- `RESULTS_BUCKET` unset, or a separate `-staging` bucket with the same
  lifecycle rule.
- CF Access is optional for staging, as it is generally: a plain `run.app` URL
  works because core fails closed on auth, and the staging gateway simply omits
  the `CF_ACCESS_*` secrets. If you do want tunnel parity, use its own
  cloudflared tunnel hostname and CF Access application — the staging gateway
  gets a service token for *that* application, not production's.

## Docker / Kubernetes

For Docker or K8s, use the same container image. The only runtime requirement
is the env vars listed in `docs/configuration.md`. The `functions-framework`
entry point serves HTTP on the port specified by the `PORT` env var (Cloud Run
sets this automatically).

For K8s, create a Secret with your env vars and mount it as envFrom:

```yaml
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
      - name: charter
        image: your-registry/charter:latest
        envFrom:
        - secretRef:
            name: charter-config
```
