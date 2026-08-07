"""Generalized Google credential-minting one-off for adopters.

Mint a Drive refresh token and store it as an authorized-user JSON in
Secret Manager. Project/secret names from args or env, no literals.

Usage:
    charter mint-google-token --client-secrets <path.json> [--secret-name <name>] [--dry-run]
"""
import argparse
import json

from google.cloud import secretmanager

from charter.settings import get_settings

SCOPES = [
    "https://www.googleapis.com/auth/drive.readonly",
    # drive.file (create/manage only files this app creates): needed by the
    # gdrive pack's resumable-upload verb — the local→Drive hop for binaries
    # that must never go inline (§4.5). Re-run this mint once after adding it.
    "https://www.googleapis.com/auth/drive.file",
]


def mint(client_secrets):
    # local/dev-only dep (not in the container requirements) — imported here so the
    # module stays importable (and its tests collectable) without google-auth-oauthlib.
    from google_auth_oauthlib.flow import InstalledAppFlow
    flow = InstalledAppFlow.from_client_secrets_file(client_secrets, scopes=SCOPES)
    # prompt=consent forces a refresh_token even on re-consent; offline is the installed-app default
    creds = flow.run_local_server(port=0, prompt="consent")
    info = json.loads(creds.to_json())
    out = {k: info[k] for k in ("client_id", "client_secret", "refresh_token") if info.get(k)}
    if not out.get("refresh_token"):
        raise SystemExit("no refresh_token returned — re-run (the consent screen must be completed).")
    return out


def store(out, secret_name=None):
    sm = secretmanager.SecretManagerServiceClient()
    s = get_settings()
    name = secret_name or s.google_refresh_secret_name
    parent = f"projects/{s.gcp_project}/secrets/{name}"
    try:
        sm.get_secret(name=parent)
    except Exception:
        sm.create_secret(parent=f"projects/{s.gcp_project}",
                         secret_id=name,
                         secret={"replication": {"automatic": {}}})
    sm.add_secret_version(parent=parent, payload={"data": json.dumps(out).encode()})


def main(argv=None):
    ap = argparse.ArgumentParser(prog="charter mint-google-token")
    ap.add_argument("--client-secrets", required=True)
    ap.add_argument("--secret-name", help="Secret Manager secret name (default: from settings)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    out = mint(args.client_secrets)
    if args.dry_run:
        print("DRY RUN — would write to",
              f"{get_settings().gcp_project}/{args.secret_name or get_settings().google_refresh_secret_name}:",
              json.dumps({**out, "refresh_token": "<redacted>"}, indent=2))
        return
    store(out, args.secret_name)
    print(f"wrote {args.secret_name or get_settings().google_refresh_secret_name} "
          "(refresh_token stored; raw never printed)")


if __name__ == "__main__":
    main()
