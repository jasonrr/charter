"""Append-only audit log -> <gcp_project>.<audit_table> (settings-derived).

record() always raises on a write failure; the CALLER chooses fail-open vs
fail-closed. Read/status/draft verbs pass fail_open=True (swallow + log);
the publish verb's preflight passes fail_open=False so a publish never lands
without a durable record.
"""
import contextvars
import logging
import datetime
import re

import requests
from google.cloud import bigquery

from charter.settings import get_settings

# W3C traceparent, version 00: "00-<32 hex trace id>-<16 hex span id>-<2 hex flags>".
# Matched strictly, and an all-zero trace or span id is invalid per the spec.
_TRACEPARENT_RE = re.compile(r"\A00-(?!0{32}-)[0-9a-f]{32}-(?!0{16}-)[0-9a-f]{16}-[0-9a-f]{2}\Z")

_TRACE: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "charter_traceparent", default=None)


def begin_trace(traceparent):
    """Record this request's inbound W3C trace context (dispatcher only).

    Called unconditionally once per request, like identity_context.begin() and
    for the same reason: thread pools reuse threads, so a value left over from
    the previous request would otherwise be attributed to this one.

    The value arrives from the caller, so it is validated rather than stored as
    given -- anything that is not a well-formed traceparent is dropped. Same
    argument as _bounded_verb in main.py: an audit row is evidence, not a place
    a caller gets to park arbitrary text.

    Non-strings are dropped rather than matched, for _bounded_verb's other
    reason: a front end that is not the reference gateway may hand this
    straight off a JSON body, where it can be an object or an array, and
    re.match on one raises.
    """
    ok = isinstance(traceparent, str) and _TRACEPARENT_RE.match(traceparent)
    _TRACE.set(traceparent if ok else None)


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


_D1_URL = "https://api.cloudflare.com/client/v4/accounts/{acct}/d1/database/{db}/query"


def _d1_insert(row):
    s = get_settings()
    row = {k: v for k, v in row.items() if v is not None}   # absent column -> NULL
    cols = list(row)                                         # fixed literals from record(), never caller input
    sql = f"INSERT INTO audit ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})"
    r = requests.post(
        _D1_URL.format(acct=s.cf_account_id, db=s.cf_d1_database_id),
        headers={"Authorization": f"Bearer {s.cf_api_token.get_secret_value()}",
                 "Content-Type": "application/json"},
        json={"sql": sql, "params": [row[c] for c in cols]},
        timeout=(3, 5),      # connect, read: a dead D1 fails 'pre' audit in <=8 s, not 10
    )
    try:
        body = r.json() if r.content else {}
    except ValueError:
        body = {}
    if not r.ok or not body.get("success"):
        raise RuntimeError(f"d1 audit insert failed: HTTP {r.status_code} {body.get('errors')}")


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
    traceparent = _TRACE.get()
    if traceparent:
        # Read from context rather than threaded through record()'s ~15 call sites:
        # it is one value fixed for the whole request, and every caller would pass
        # the same thing. Same omitted-when-unset pattern as the two above.
        row["traceparent"] = traceparent
    try:
        if get_settings().charter_backend == "cloudflare":
            _d1_insert(row)
        else:
            errors = _client().insert_rows_json(_table(), [row])
            if errors:
                raise RuntimeError(f"audit insert errors: {errors}")
    except Exception as e:
        logging.error("audit write failed (verb=%s rid=%s): %s", verb, rid, e)
        if not fail_open:
            raise
