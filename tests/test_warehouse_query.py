"""data.warehouse.query gates: statement-type, table allowlist, caps, envelope.

Fakes only — no real BigQuery. FakeBQ serves queued jobs in order (a query
call is dry-run first, then execution), recording (sql, job_config) so tests
can prove the SQL is never rewritten and the caps are actually set.
"""
import concurrent.futures
import datetime
import json
import types
from decimal import Decimal

import pytest
from google.api_core import exceptions as gexc

from charter.packs.bigquery import warehouse_query
from charter.errors import VerbError


@pytest.fixture(autouse=True)
def _pack_env(monkeypatch):
    # GCP_PROJECT comes from conftest (charter-fixture, matching tref's default).
    monkeypatch.setenv("WAREHOUSE_DATASETS", "sales_sync,marketing_sync")


def tref(dataset, table, project="charter-fixture"):
    return types.SimpleNamespace(project=project, dataset_id=dataset, table_id=table)


class FakeJob:
    def __init__(self, rows=(), statement_type="SELECT", refs=(), bytes_=1000,
                 result_error=None):
        self.statement_type = statement_type
        self.referenced_tables = None if refs is None else list(refs)
        self.total_bytes_processed = bytes_
        self._rows = list(rows)
        self._result_error = result_error

    def result(self, max_results=None, timeout=None):
        if self._result_error:
            raise self._result_error
        return self._rows if max_results is None else self._rows[:max_results]


class FakeBQ:
    def __init__(self, jobs):
        self.jobs = list(jobs)
        self.calls = []                      # (sql, job_config)

    def query(self, sql, job_config=None):
        self.calls.append((sql, job_config))
        job = self.jobs.pop(0)
        if isinstance(job, Exception):
            raise job
        return job


def q(sql="SELECT deal_stage FROM `charter-fixture.sales_sync.deals`", **kw):
    return {"verb": "data.warehouse.query", "sql": sql, **kw}


DEALS = [tref("sales_sync", "deals")]


def _patch(monkeypatch, jobs):
    fake = FakeBQ(jobs)
    monkeypatch.setattr(warehouse_query, "bq", fake)
    return fake


# ---- gates ----

@pytest.mark.parametrize("stype", ["UPDATE", "DELETE", "INSERT", "MERGE", "SCRIPT",
                                   "CREATE_TABLE_AS_SELECT", "DROP_TABLE", "EXPORT_DATA"])
def test_rejects_non_select(monkeypatch, stype):
    fake = _patch(monkeypatch, [FakeJob(statement_type=stype, refs=DEALS)])
    with pytest.raises(VerbError) as e:
        warehouse_query.run(q(), {})
    assert e.value.code == "not_select" and e.value.status == 400
    assert len(fake.calls) == 1              # dry-run only, never executed


def test_rejects_blocked_dataset(monkeypatch):
    _patch(monkeypatch, [FakeJob(refs=[tref("restricted", "audit")])])
    with pytest.raises(VerbError) as e:
        warehouse_query.run(q("SELECT * FROM restricted.audit"), {})
    assert e.value.code == "blocked_table"
    assert "charter-fixture.restricted.audit" in e.value.detail


def test_rejects_foreign_project(monkeypatch):
    _patch(monkeypatch, [FakeJob(refs=[tref("sales_sync", "deals", project="other-proj")])])
    with pytest.raises(VerbError) as e:
        warehouse_query.run(q(), {})
    assert e.value.code == "blocked_table"


def test_rejects_over_bytes_cap(monkeypatch):
    fake = _patch(monkeypatch, [FakeJob(refs=DEALS, bytes_=warehouse_query.BYTES_CAP + 1)])
    with pytest.raises(VerbError) as e:
        warehouse_query.run(q(), {})
    assert e.value.code == "bytes_cap" and len(fake.calls) == 1


def test_bq_error_passthrough(monkeypatch):
    _patch(monkeypatch, [gexc.BadRequest("Syntax error: Unexpected FROM at [1:8]")])
    with pytest.raises(VerbError) as e:
        warehouse_query.run(q("SELECT FROM nope"), {})
    assert e.value.code == "query_error" and "Syntax error" in e.value.detail


def test_missing_sql(monkeypatch):
    _patch(monkeypatch, [])
    with pytest.raises(VerbError) as e:
        warehouse_query.run({"verb": "data.warehouse.query"}, {})
    assert e.value.code == "bad_request"


def test_bad_max_rows(monkeypatch):
    _patch(monkeypatch, [])
    with pytest.raises(VerbError) as e:
        warehouse_query.run(q(max_rows="lots"), {})
    assert e.value.code == "bad_request"


def test_unknown_leaf(monkeypatch):
    _patch(monkeypatch, [])
    with pytest.raises(VerbError) as e:
        warehouse_query.run({"verb": "data.warehouse.nuke"}, {})
    assert e.value.code == "unknown_verb" and e.value.status == 404


# ---- execution ----

def test_happy_path_envelope_and_caps(monkeypatch):
    sql = "SELECT deal_stage, COUNT(*) n FROM `charter-fixture.sales_sync.deals` GROUP BY 1"
    rows = [{"deal_stage": "Engaged", "n": 3}]
    fake = _patch(monkeypatch, [FakeJob(refs=DEALS, bytes_=2048),
                                FakeJob(rows=rows, refs=DEALS, bytes_=2048)])
    out = warehouse_query.run(q(sql), {})
    assert out["rows"] == rows and out["row_count"] == 1 and out["truncated"] is False
    assert out["target"] == "bigquery:sales_sync.deals"
    assert out["total_bytes_processed"] == 2048
    detail = json.loads(out["_audit_detail"])
    assert detail["rows"] == 1 and detail["sql"].startswith("SELECT deal_stage")
    assert fake.calls[0][1].dry_run is True
    assert fake.calls[1][0] == sql                        # SQL never rewritten
    assert fake.calls[1][1].maximum_bytes_billed == warehouse_query.BYTES_CAP


def test_truncation(monkeypatch):
    rows = [{"n": i} for i in range(5)]
    _patch(monkeypatch, [FakeJob(refs=DEALS), FakeJob(rows=rows, refs=DEALS)])
    out = warehouse_query.run(q(max_rows=2), {})
    assert out["row_count"] == 2 and out["truncated"] is True and len(out["rows"]) == 2


def test_max_rows_hard_cap(monkeypatch):
    _patch(monkeypatch, [FakeJob(refs=DEALS), FakeJob(rows=[], refs=DEALS)])
    out = warehouse_query.run(q(max_rows=999999), {})
    assert out["truncated"] is False          # capped internally at MAX_ROWS, no error


def test_dry_run_param(monkeypatch):
    fake = _patch(monkeypatch, [FakeJob(refs=DEALS, bytes_=4096)])
    out = warehouse_query.run(q(dry_run=True), {})
    assert out["dry_run"] is True and out["total_bytes_processed"] == 4096
    assert out["referenced_tables"] == ["charter-fixture.sales_sync.deals"]
    assert len(fake.calls) == 1               # never executed


def test_timeout(monkeypatch):
    _patch(monkeypatch, [FakeJob(refs=DEALS),
                         FakeJob(refs=DEALS, result_error=concurrent.futures.TimeoutError())])
    with pytest.raises(VerbError) as e:
        warehouse_query.run(q(), {})
    assert e.value.code == "timeout" and e.value.status == 504


def test_execution_error_passthrough(monkeypatch):
    _patch(monkeypatch, [FakeJob(refs=DEALS),
                         FakeJob(refs=DEALS, result_error=gexc.BadRequest("exceeded limit"))])
    with pytest.raises(VerbError) as e:
        warehouse_query.run(q(), {})
    assert e.value.code == "query_error"


def test_row_values_coerced_deeply(monkeypatch):
    rows = [{"dates": [datetime.date(2020, 1, 1)],
             "s": {"d": datetime.date(2020, 1, 2), "n": Decimal("1.5")}}]
    _patch(monkeypatch, [FakeJob(refs=DEALS), FakeJob(rows=rows, refs=DEALS)])
    out = warehouse_query.run(q(), {})
    assert out["rows"] == [{"dates": ["2020-01-01"],
                            "s": {"d": "2020-01-02", "n": 1.5}}]
    json.dumps(out)                           # must not raise TypeError


def test_allows_second_dataset(monkeypatch):
    refs = [tref("marketing_sync", "contacts")]
    fake = _patch(monkeypatch, [FakeJob(refs=refs), FakeJob(rows=[], refs=refs)])
    out = warehouse_query.run(q(), {})
    assert out["target"] == "bigquery:marketing_sync.contacts"
    assert len(fake.calls) == 2


def test_blocked_table_lists_only_the_blocked_one(monkeypatch):
    refs = [tref("sales_sync", "deals"), tref("restricted", "audit")]
    _patch(monkeypatch, [FakeJob(refs=refs)])
    with pytest.raises(VerbError) as e:
        warehouse_query.run(q(), {})
    assert e.value.code == "blocked_table"
    assert e.value.detail == ["charter-fixture.restricted.audit"]


def test_dry_run_with_no_referenced_tables(monkeypatch):
    fake = _patch(monkeypatch, [FakeJob(refs=None), FakeJob(rows=[], refs=None)])
    out = warehouse_query.run(q("SELECT 1"), {})
    assert out["target"] == "bigquery:"
    assert len(fake.calls) == 2               # dry-run allowed the query through


# ---- data.warehouse.schema ----

def _catalog_jobs():
    """One __TABLES__ job + one TABLE_OPTIONS job per allowed dataset, in order."""
    tables = FakeJob(rows=[types.SimpleNamespace(table_id="deals", row_count=1200, type=1),
                           types.SimpleNamespace(table_id="vw_mcc_deals", row_count=0, type=2)])
    opts = FakeJob(rows=[types.SimpleNamespace(table_name="vw_mcc_deals",
                                               option_value='"Cohort deals view"')])
    return [tables, opts]


def test_schema_catalog_includes_guide(monkeypatch):
    _patch(monkeypatch, _catalog_jobs() + _catalog_jobs())     # sales_sync + marketing_sync
    out = warehouse_query.run({"verb": "data.warehouse.schema"}, {})
    at = out["datasets"]["sales_sync"]
    assert {"name": "deals", "rows": 1200, "kind": "table", "description": ""} in at
    assert {"name": "vw_mcc_deals", "rows": 0, "kind": "view",
            "description": "Cohort deals view"} in at
    assert "Warehouse Analyst Guide" in out["guide"] and out["target"] == "catalog"


def test_schema_catalog_degrades_per_dataset(monkeypatch):
    _patch(monkeypatch, [gexc.Forbidden("nope")] + _catalog_jobs())
    out = warehouse_query.run({"verb": "data.warehouse.schema"}, {})
    assert out["datasets"]["sales_sync"] == "unavailable"
    assert isinstance(out["datasets"]["marketing_sync"], list)


def test_schema_table_detail_parameterized(monkeypatch):
    cols = FakeJob(rows=[types.SimpleNamespace(field_path="deal_stage", data_type="STRING",
                                               description="Pipeline stage")])
    fake = _patch(monkeypatch, [cols])
    out = warehouse_query.run({"verb": "data.warehouse.schema",
                               "table": "sales_sync.deals"}, {})
    assert out["columns"] == [{"name": "deal_stage", "type": "STRING",
                               "description": "Pipeline stage"}]
    sql, config = fake.calls[0]
    assert "deals" not in sql                 # table name is a query parameter, not interpolated
    assert config.query_parameters[0].value == "deals"


def test_schema_unknown_dataset(monkeypatch):
    _patch(monkeypatch, [])
    with pytest.raises(VerbError) as e:
        warehouse_query.run({"verb": "data.warehouse.schema",
                             "table": "restricted.audit"}, {})
    assert e.value.code == "unknown_table" and e.value.status == 404


def test_schema_table_not_found(monkeypatch):
    _patch(monkeypatch, [FakeJob(rows=[])])
    with pytest.raises(VerbError) as e:
        warehouse_query.run({"verb": "data.warehouse.schema",
                             "table": "sales_sync.nope"}, {})
    assert e.value.code == "unknown_table"
