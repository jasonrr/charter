"""data.warehouse.* verbs: ad-hoc read-only GoogleSQL over the synced warehouse.

data.warehouse.schema -> dataset/table/column catalog + the analyst guide.
data.warehouse.query  -> caller-written SELECT. Read-only is enforced by four
independent layers:
  1. the query runs as the viewer-only warehouse-query SA (impersonated —
     never the runtime's ambient credentials), so DML/DDL fails at the engine;
  2. a dry run must type the statement as SELECT (scripts type as SCRIPT);
  3. dry-run referenced_tables must stay inside ALLOWED_DATASETS;
  4. byte / row / time caps bound cost and response size.
No SQL string parsing here on purpose — BigQuery's parser is the authority.
"""
import concurrent.futures
import json
import functools
import pathlib
import re

import google.auth
from google.api_core import exceptions as gexc
from google.auth import impersonated_credentials
from google.cloud import bigquery

from charter.sdk import _safe_deep
from charter.errors import VerbError
from charter.settings import get_settings



DEFAULT_ROWS, MAX_ROWS = 1000, 5000
BYTES_CAP = 2 * 1024**3        # 2 GiB
TIMEOUT_S = 60

GUIDE = pathlib.Path(__file__).with_name("warehouse_guide.md")


@functools.lru_cache(maxsize=None)
def _guide_text():
    # static package data — read once per process, not per schema call
    return GUIDE.read_text() if GUIDE.exists() else ""
_TABLE_RE = re.compile(r"^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)$")


def _make_client():
    s = get_settings()
    source, _ = google.auth.default()
    # Pack config: the SA email to impersonate for warehouse queries.
    # Default uses the conventional naming pattern.
    sa_email = getattr(s, "warehouse_sa_email", "") or f"warehouse-query@{s.gcp_project}.iam.gserviceaccount.com"
    creds = impersonated_credentials.Credentials(
        source_credentials=source,
        target_principal=sa_email,
        target_scopes=["https://www.googleapis.com/auth/cloud-platform"])
    return bigquery.Client(project=s.gcp_project, credentials=creds)


def _client():
    """Lazy impersonated client. Reads through module globals so a patched
    `warehouse_query.bq` keeps working; importing this module needs no ADC."""
    c = globals().get("bq")
    if c is None:
        c = globals()["bq"] = _make_client()
    return c


def __getattr__(name):
    if name == "bq":
        return _client()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def run(body, caller):
    """Ad-hoc read-only SQL over the synced warehouse: data.warehouse.schema for the catalog + analyst guide, data.warehouse.query to run a GoogleSQL SELECT (enforced read-only, capped)."""
    leaf = body.get("verb", "").removeprefix("data.warehouse.")
    if leaf == "schema":
        return _schema(body)
    if leaf == "query":
        return _query(body)
    raise VerbError(404, "unknown_verb", leaf)


def _dry_run(sql):
    """Gatekeeper: BigQuery's own parse of the statement. Returns (job, table names)."""
    try:
        job = _client().query(sql, job_config=bigquery.QueryJobConfig(dry_run=True))
    except gexc.GoogleAPICallError as e:
        raise VerbError(400, "query_error", e.message)   # verbatim, so the caller can self-correct
    if job.statement_type != "SELECT":
        raise VerbError(400, "not_select",
                        f"only SELECT is allowed, statement is {job.statement_type}")
    tables = sorted({f"{t.project}.{t.dataset_id}.{t.table_id}"
                     for t in job.referenced_tables or []})
    s = get_settings()
    blocked = [t for t in tables
               if t.split(".")[0] != s.gcp_project
               or t.split(".")[1] not in s.warehouse_datasets]
    if blocked:
        raise VerbError(400, "blocked_table", blocked)
    if (job.total_bytes_processed or 0) > BYTES_CAP:
        raise VerbError(400, "bytes_cap",
                        f"query would scan {job.total_bytes_processed} bytes (cap {BYTES_CAP}); "
                        "narrow the date range or select fewer columns")
    return job, tables


def _schema(body):
    """Catalog: datasets/tables/row counts + the analyst guide; or one table's columns."""
    s = get_settings()
    allowed = s.warehouse_datasets
    table = body.get("table")
    if table:
        m = _TABLE_RE.match(str(table))
        if not m or m.group(1) not in allowed:
            raise VerbError(404, "unknown_table",
                            f"{table!r} — use dataset.table within {list(allowed)}")
        ds, name = m.groups()
        rows = list(_client().query(
            f"SELECT field_path, data_type, description "
            f"FROM `{s.gcp_project}.{ds}`.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS "
            f"WHERE table_name = @t ORDER BY field_path",
            job_config=bigquery.QueryJobConfig(
                query_parameters=[bigquery.ScalarQueryParameter("t", "STRING", name)])
        ).result())
        if not rows:
            raise VerbError(404, "unknown_table", table)
        return {"table": f"{ds}.{name}",
                "columns": [{"name": r.field_path, "type": r.data_type,
                             "description": r.description or ""} for r in rows],
                "target": f"bigquery:{ds}.{name}"}
    datasets = {}
    client = _client()
    for ds in allowed:
        try:                                   # discovery degrades per-dataset, never breaks
            counts = list(client.query(
                f"SELECT table_id, row_count, type "
                f"FROM `{s.gcp_project}.{ds}.__TABLES__`").result())
            descs = {}
            for r in client.query(
                    f"SELECT table_name, option_value "
                    f"FROM `{s.gcp_project}.{ds}`.INFORMATION_SCHEMA.TABLE_OPTIONS "
                    f"WHERE option_name = 'description'").result():
                try:
                    descs[r.table_name] = json.loads(r.option_value)
                except (ValueError, TypeError):
                    descs[r.table_name] = r.option_value
            datasets[ds] = sorted(
                ({"name": r.table_id, "rows": r.row_count,
                  "kind": "view" if r.type == 2 else "table",
                  "description": descs.get(r.table_id, "")} for r in counts),
                key=lambda t: t["name"])
        except Exception:
            datasets[ds] = "unavailable"
    guide = _guide_text() if GUIDE.exists() else ""
    return {"datasets": datasets, "guide": guide, "target": "catalog"}


def _query(body):
    sql = body.get("sql")
    if not isinstance(sql, str) or not sql.strip():
        raise VerbError(400, "bad_request", "sql (a GoogleSQL SELECT string) is required")
    try:
        max_rows = min(int(body.get("max_rows") or DEFAULT_ROWS), MAX_ROWS)
        if max_rows < 1:
            raise ValueError
    except (TypeError, ValueError):
        raise VerbError(400, "bad_request", f"max_rows must be a positive integer (cap {MAX_ROWS})")
    dry, tables = _dry_run(sql)
    prefix = get_settings().gcp_project + "."
    target = "bigquery:" + ",".join(t.removeprefix(prefix) for t in tables)
    if body.get("dry_run"):
        return {"dry_run": True, "total_bytes_processed": dry.total_bytes_processed,
                "referenced_tables": tables, "target": target}
    job = _client().query(sql, job_config=bigquery.QueryJobConfig(
        maximum_bytes_billed=BYTES_CAP,
        labels={"charter-verb": "data-warehouse-query"}))
    try:
        it = job.result(max_results=max_rows + 1, timeout=TIMEOUT_S)
        rows = [{k: _safe_deep(v) for k, v in r.items()} for r in it]
    except concurrent.futures.TimeoutError:
        raise VerbError(504, "timeout", f"query exceeded {TIMEOUT_S}s")
    except gexc.GoogleAPICallError as e:
        raise VerbError(400, "query_error", e.message)
    row_count = min(len(rows), max_rows)
    return {"rows": rows[:max_rows], "row_count": row_count,
            "truncated": len(rows) > max_rows,
            "total_bytes_processed": job.total_bytes_processed, "target": target,
            "_audit_detail": json.dumps(       # popped by the dispatcher into the audit row
                {"sql": sql[:2000], "bytes": job.total_bytes_processed, "rows": row_count})}
