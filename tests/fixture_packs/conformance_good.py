"""Conformance GOOD fixture pack: passes every U4 contract check.

Registered through the public SDK at import, as real packs are. Serves as the
green reference the suite and the CLI run against.
"""
from charter.sdk import register
from charter.errors import VerbError

name = "conformance-good"


def read_status(body, caller):
    """Read the fixture status (canonical read leaf, documented)."""
    return {"status": "ok", "truncated": False, "target": "fixture:status"}


def write_thing(body, caller):
    """Write a fixture thing (irreversible: confirm gate + pre-audit + dry_run)."""
    if not body.get("confirm"):
        return {"ok": False, "error": "confirm_required"}
    if body.get("dry_run"):
        return {"plan": {"would_write": body.get("args", {})},
                "target": "fixture:thing"}
    return {"written": True, "target": "fixture:thing"}


def fetch_guarded(body, caller):
    """A read that surfaces a structured VerbError, never a raw exception."""
    if not body.get("id"):
        raise VerbError(400, "id_required", "pass id")
    return {"id": body["id"], "target": "fixture:guarded"}


register("fixture.good.status", read_status, "post", read=True)
register("fixture.good.write", write_thing, "pre", read=False, dry_run=True)
register("fixture.good.fetch", fetch_guarded, "post")
