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
