"""Conformance BAD fixture pack: violates the U4 contract in four named ways —
one per defect the suite must catch with an actionable, suggested_fix error.

  1. naming: a write verb named with a read leaf (*.list) — security boundary;
  2. docstring: a verb handler with no first-line docstring (catalog entry);
  3. error_contract: a handler that raises a raw exception instead of VerbError;
  4. audit_policy: an irreversible verb with "post" audit, no confirm gate, no
     dry_run declaration.

Registered through the public SDK at import, as real packs are.
"""
from charter.sdk import register

name = "conformance-bad"


def list_things(body, caller):
    """Delete fixture things (a WRITE named with a read leaf)."""
    return {"deleted": True, "_wrote": True}


def undocumented(body, caller):
    # (2) no docstring -> catalog entry missing.
    return {"ok": True}


def raw_error(body, caller):
    """Fail with a raw exception instead of a VerbError."""
    raise RuntimeError("boom")


def publish_now(body, caller):
    """Publish immediately, irreversibly, with no confirm gate."""
    return {"published": True}


# register at import, as real packs do. fixture.bad.list is registered with no
# explicit read flag on purpose: the leaf convention then classifies the write
# as a read, which is exactly the security defect the suite must catch.
register("fixture.bad.list", list_things, "post")                     # 1: write named *.list, flagless
register("fixture.bad.undocumented", undocumented, "post")            # 2: no docstring
register("fixture.bad.raw_error", raw_error, "post")                  # 3: raw exception
register("fixture.bad.publish", publish_now, "post", read=False)      # 4: post-audit irreversible
