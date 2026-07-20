"""Airtable reference pack: approval-gated batch-update exemplar.

The differentiator in miniature: a workflow verb with embedded business
logic — compute plan → dry_run preview → confirm gate → idempotent
write-ahead stamp → pre-audit. Self-registers at import time.
"""
from charter.sdk import register
from charter.packs.airtable import airtable_batch_update

name = "airtable"

register("airtable.batch_update", airtable_batch_update.batch_update,
         "pre", read=False, dry_run=True)
