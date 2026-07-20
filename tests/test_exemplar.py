"""U5 exemplar tests: dry_run preview + confirm gate + idempotent stamp + conformance.

Proof-first: the exemplar demonstrates the full approval-gated workflow pattern
against a faked Airtable (exact records planned, exact records patched).
"""
import charter.main as main

from charter.sdk import _DRY_RUN
from tests.test_bridge import FakeRequest, _parse
from charter.packs.airtable import airtable_batch_update


_RECORDS = [
    {"id": "rec1", "fields": {"Status": "Pending"}},
    {"id": "rec2", "fields": {"Status": "Pending"}},
]


def _run(body, monkeypatch, records=_RECORDS):
    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "jason", "interface": "cc", "allow": ["*"]})
    monkeypatch.setattr(main, "allowed", lambda caller, verb: True)
    calls = []
    monkeypatch.setattr(main, "record", lambda *a, **k: calls.append((a, k)))
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    monkeypatch.setitem(main.VERBS, "airtable.batch_update",
                        (airtable_batch_update.batch_update, "pre"))
    _DRY_RUN.add("airtable.batch_update")
    monkeypatch.setattr(airtable_batch_update.airtable_rw, "list_records",
                        lambda table_id, filter_formula="": list(records))
    patches = []
    monkeypatch.setattr(airtable_batch_update.airtable_rw, "patch_records",
                        lambda table_id, recs: patches.append((table_id, recs)))
    return _parse(main.bridge(FakeRequest(body=body))), calls, patches


def test_exemplar_dry_run_lists_exact_records(monkeypatch):
    """dry_run:true returns the plan with no side effect and no attempt row."""
    (body, status), calls, patches = _run({
        "verb": "airtable.batch_update",
        "table_id": "tblTest",
        "filter_formula": "{Status}='Pending'",
        "updates": {"Status": "Approved", "Approved_At": "2026-06-24"},
        "dry_run": True,
    }, monkeypatch)

    assert status == 200
    assert body["dry_run"] is True
    plan = body["plan"]
    assert plan["table_id"] == "tblTest"
    assert plan["record_ids"] == ["rec1", "rec2"]
    assert plan["records_found"] == 2
    assert plan["fields_to_update"] == ["Status", "Approved_At"]
    assert plan["proposed_changes"] == {"Status": "Approved", "Approved_At": "2026-06-24"}
    assert patches == []                                   # no side effect
    assert not any(a[3] == "attempt" for a, k in calls)    # no attempt row


def test_exemplar_real_run_updates_exact_records(monkeypatch):
    """confirm:true patches exactly the planned records with stamp + updates."""
    (body, status), calls, patches = _run({
        "verb": "airtable.batch_update",
        "table_id": "tblTest",
        "updates": {"Status": "Approved"},
        "stamp_field": "Batch_Stamp",
        "confirm": True,
    }, monkeypatch)

    assert status == 200
    assert body["updated"] == 2
    assert body["fields_changed"] == ["Status"]
    assert body["target"] == "airtable:tblTest"
    (table_id, recs), = patches
    assert table_id == "tblTest"
    assert [r["id"] for r in recs] == ["rec1", "rec2"]
    assert all(r["fields"]["Status"] == "Approved" for r in recs)
    assert all(r["fields"]["Batch_Stamp"] for r in recs)   # write-ahead stamp
    assert any(a[3] == "attempt" for a, k in calls)
    assert any(a[3] == "ok" for a, k in calls)


def test_exemplar_retry_skips_already_stamped(monkeypatch):
    """Idempotency: records already carrying the stamp are excluded from the plan."""
    records = [
        {"id": "rec1", "fields": {"Status": "Pending", "Batch_Stamp": "2026-06-24"}},
        {"id": "rec2", "fields": {"Status": "Pending"}},
    ]
    (body, status), calls, patches = _run({
        "verb": "airtable.batch_update",
        "table_id": "tblTest",
        "updates": {"Status": "Approved"},
        "stamp_field": "Batch_Stamp",
        "confirm": True,
    }, monkeypatch, records=records)

    assert status == 200
    assert body["updated"] == 1
    assert body["plan"]["already_stamped"] == 1
    (_, recs), = patches
    assert [r["id"] for r in recs] == ["rec2"]


def test_exemplar_no_confirm_returns_confirm_required(monkeypatch):
    """Neither dry_run nor confirm -> confirm_required."""
    (body, status), calls, patches = _run({
        "verb": "airtable.batch_update",
        "table_id": "tblTest",
        "updates": {"Status": "Approved"},
    }, monkeypatch)

    assert status == 400
    assert body["error"] == "confirm_required"
    assert patches == []
    # pre-audit row IS written because dry_run is false (fail-closed)
    assert any(a[3] == "attempt" for a, k in calls)


def test_exemplar_missing_args_is_invalid_args(monkeypatch):
    """No table_id/updates -> named VerbError, even under dry_run."""
    (body, status), calls, patches = _run({
        "verb": "airtable.batch_update",
        "table_id": "tblTest",
        "dry_run": True,
    }, monkeypatch)

    assert status == 400
    assert body["error"] == "invalid_args"
    assert patches == []


def test_exemplar_conformance_passes(monkeypatch):
    """The exemplar pack passes the U4 conformance suite."""
    from charter.packtest.checks import evaluate_pack
    results = evaluate_pack(airtable_batch_update)
    failures = [r for r in results if r.level == "failure"]
    assert not failures, f"conformance failures: {failures}"
