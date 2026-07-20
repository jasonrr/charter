"""Exemplar: generic approval-gated Airtable batch-update workflow verb.

Demonstrates the full pattern: compute batch plan → dry_run preview →
confirm:true gate → idempotent write-ahead stamp → "pre" audit.
Uses Airtable-only deps (the shared client in airtable_rw.py).
"""
import datetime

from charter.errors import VerbError
from charter.packs.airtable import airtable_rw


def _today():
    return datetime.date.today().isoformat()


def _build_plan(table_id, filter_formula, updates, stamp_field, today):
    """Fetch matching records and compute what would change.

    Records already carrying the write-ahead stamp are excluded, so re-running
    a partially applied batch only touches the remainder (idempotency).
    """
    records = airtable_rw.list_records(table_id, filter_formula)
    pending = [r for r in records
               if not (stamp_field and r.get("fields", {}).get(stamp_field))]
    return {
        "table_id": table_id,
        "filter_formula": filter_formula,
        "records_found": len(pending),
        "record_ids": [r["id"] for r in pending],
        "already_stamped": len(records) - len(pending),
        "fields_to_update": list(updates.keys()),
        "proposed_changes": updates,
        "stamp_field": stamp_field or None,
        "stamp_date": today,
    }


def batch_update(body, caller):
    """Approval-gated Airtable batch update: dry_run previews, confirm executes.

    Args: table_id, updates (field → value), optional filter_formula, optional
    stamp_field (a field written with today's date alongside the update — the
    write-ahead stamp that makes retries idempotent).
    """
    table_id = body.get("table_id")
    filter_formula = body.get("filter_formula", "")
    updates = body.get("updates", {})
    stamp_field = body.get("stamp_field", "")

    if not table_id or not updates:
        raise VerbError(400, "invalid_args", "table_id and updates are required")

    plan = _build_plan(table_id, filter_formula, updates, stamp_field, _today())

    if body.get("dry_run"):
        return {"plan": plan, "dry_run": True}

    if body.get("confirm") is not True:
        return {"ok": False, "error": "confirm_required"}

    # Write-ahead stamp lands in the same PATCH as the update: each record
    # either fully carries the change + stamp or neither, and a retry after a
    # mid-batch failure skips already-stamped records via the plan.
    fields = dict(updates)
    if stamp_field:
        fields[stamp_field] = plan["stamp_date"]
    airtable_rw.patch_records(
        table_id, [{"id": rid, "fields": fields} for rid in plan["record_ids"]])

    return {
        "target": f"airtable:{table_id}",
        "updated": plan["records_found"],
        "fields_changed": plan["fields_to_update"],
        "plan": plan,  # included for audit traceability
    }
