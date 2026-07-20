"""Append-only audit log -> <gcp_project>.<audit_table> (settings-derived).

record() always raises on a write failure; the CALLER chooses fail-open vs
fail-closed. Read/status/draft verbs pass fail_open=True (swallow + log);
the publish verb's preflight passes fail_open=False so a publish never lands
without a durable record.
"""
import logging
import datetime

from google.cloud import bigquery

from charter.settings import get_settings


def _client():
    """Lazy BigQuery client. Reads through module globals so monkeypatched
    `audit.bq` fakes keep working; importing this module needs no credentials."""
    c = globals().get("bq")
    if c is None:
        c = globals()["bq"] = bigquery.Client(project=get_settings().gcp_project)
    return c


def _table():
    """Lazy settings-derived table id, same read-through pattern."""
    t = globals().get("TABLE")
    if t is None:
        s = get_settings()
        t = globals()["TABLE"] = f"{s.gcp_project}.{s.audit_table}"
    return t


def __getattr__(name):
    # External access (monkeypatch raising=True checks, attribute reads) lands here.
    if name == "bq":
        return _client()
    if name == "TABLE":
        return _table()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def record(caller, verb, target, result, rid, detail=None, fail_open=True,
           on_behalf_of=None, credential=None):
    row = {
        "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "actor": caller["name"] if caller else None,
        "interface": caller["interface"] if caller else None,
        "verb": verb,
        "target": target,
        "result": result,
        "detail": None if detail is None else str(detail),
        "request_id": rid,
    }
    if on_behalf_of:
        # Omitted (not null) when unset: insert_rows_json rejects unknown fields, so
        # this keeps code deploys order-independent of the ALTER TABLE migration.
        row["on_behalf_of"] = on_behalf_of
    if credential:
        # Same omitted-when-unset pattern: which credential a provider seam actually
        # used ("user:<email>" or "app"), absent for verbs no provider seam touched.
        row["credential"] = credential
    try:
        errors = _client().insert_rows_json(_table(), [row])
        if errors:
            raise RuntimeError(f"audit insert errors: {errors}")
    except Exception as e:
        logging.error("audit write failed (verb=%s rid=%s): %s", verb, rid, e)
        if not fail_open:
            raise
