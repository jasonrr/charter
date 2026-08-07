"""Drive resumable-upload staging: the local → Drive hop for large binaries.

Charter's payload contract (docs/remote-mcp.md §4.5) forbids inline base64
input. This verb mirrors SEP-2631's `authorizeUpload` control-plane: the
server opens a Drive resumable-upload session and returns its URI; the CLIENT
streams the raw bytes to that URI out-of-band (`curl -X PUT --upload-file`),
so no binary ever transits the MCP proxy or the model's context. The PUT
response body carries the created Drive file's id, which downstream verbs
take by reference.

The session URI is itself the credential — Google pre-authorizes it, the PUT
needs no auth header — so treat it as a secret. Sessions expire after ~1 week.

Auth: the shared bridge identity's authorized-user JSON from Secret Manager
(settings.google_refresh_secret_name), minted by `charter mint-google-token`,
whose SCOPES include drive.file (the app touches only files it creates).
"""
import json
import threading

import requests
from google.auth.transport.requests import Request
from google.cloud import secretmanager
from google.oauth2.credentials import Credentials

from charter.errors import VerbError
from charter.settings import get_settings

SCOPES = ["https://www.googleapis.com/auth/drive.file"]
UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files"
_state = {}                  # "creds": cached Credentials for the shared identity
_lock = threading.Lock()


def _load_creds():
    s = get_settings()
    name = (f"projects/{s.gcp_project}/secrets/"
            f"{s.google_refresh_secret_name}/versions/latest")
    sm = secretmanager.SecretManagerServiceClient()
    info = json.loads(sm.access_secret_version(name=name).payload.data.decode())
    return Credentials.from_authorized_user_info(info, scopes=SCOPES)


def _token():
    with _lock:              # Credentials aren't thread-safe; Cloud Run serves concurrently
        creds = _state.get("creds")
        if creds is None:
            creds = _state["creds"] = _load_creds()
        if not creds.valid:
            creds.refresh(Request())
        return creds.token


def initiate_upload(body, caller):
    """Open a Drive resumable-upload session for a client-side file -> {upload_uri, next}; the client PUTs raw bytes to upload_uri (no auth header) and the PUT response's `id` is the Drive file id."""
    for k in ("filename", "folder_id"):
        if not body.get(k):
            raise VerbError(400, "missing_field", k)
    headers = {"Authorization": f"Bearer {_token()}",
               "Content-Type": "application/json; charset=UTF-8"}
    if body.get("mime_type"):
        headers["X-Upload-Content-Type"] = body["mime_type"]
    r = requests.post(UPLOAD_URL,
                      params={"uploadType": "resumable", "supportsAllDrives": "true"},
                      headers=headers,
                      json={"name": body["filename"], "parents": [body["folder_id"]]},
                      timeout=30)
    if r.status_code != 200:
        raise VerbError(502, "upload_session_failed", f"{r.status_code}: {r.text[:200]}")
    uri = r.headers.get("Location")
    if not uri:
        raise VerbError(502, "upload_session_failed", "no session URI in response")
    return {"upload_uri": uri, "file_name": body["filename"],
            "next": ("PUT the raw bytes to upload_uri, e.g. "
                     "curl -X PUT --upload-file <path> '<upload_uri>'. No auth "
                     "header needed; the JSON response's `id` is the Drive file "
                     "id. The session expires in ~1 week."),
            "target": f"google_folder:{body['folder_id']}"}
