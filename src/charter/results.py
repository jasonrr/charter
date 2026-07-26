"""GCS-backed store for oversized verb results (docs/remote-mcp.md §4.5).

bridge() offloads any success envelope larger than max_inline_bytes here and
returns a result_ref; the engine verb result.read fetches it back,
producer-only. Objects expire via the bucket's lifecycle rule (see
docs/deployment/gcp-cloud-run.md) — core never deletes.

Access model: the reference id is unguessable (token_urlsafe) AND re-checked —
only the caller record that produced a result may read it, and a missing id
answers exactly like someone else's id, so existence is never confirmed.
"""
import re
import secrets as _secrets

from charter.errors import VerbError
from charter.settings import get_settings

# token_urlsafe(24) -> 32 url-safe chars. The regex is the shared contract with
# the gateway (results.ts pins the same one); widen both together or neither.
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")

_client = None


def _bucket():
    global _client
    if _client is None:
        from google.cloud import storage  # deferred: keep cold start lean
        _client = storage.Client(project=get_settings().gcp_project)
    return _client.bucket(get_settings().results_bucket)


def store(body_json: str, producer: str, verb: str) -> str:
    """Write one success envelope; return its unguessable id."""
    result_id = _secrets.token_urlsafe(24)
    blob = _bucket().blob(f"results/{result_id}")
    blob.metadata = {"producer": producer, "verb": verb}
    blob.upload_from_string(body_json, content_type="application/json")
    return result_id


def fetch(result_id, producer: str) -> str:
    """Read one stored envelope back, producer-only. 404 result_unknown for
    malformed, missing, expired, and not-yours alike."""
    if not get_settings().results_bucket:
        raise VerbError(404, "result_unknown")
    if not isinstance(result_id, str) or not _ID_RE.fullmatch(result_id):
        raise VerbError(404, "result_unknown")
    blob = _bucket().get_blob(f"results/{result_id}")
    if blob is None or (blob.metadata or {}).get("producer") != producer:
        raise VerbError(404, "result_unknown")
    return blob.download_as_text()
