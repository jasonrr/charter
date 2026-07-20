"""AE9: dry_run gate in dispatcher.

Proof-first: the dispatcher skips pre-audit attempt rows ONLY when the verb
declared dry_run support AND the caller passes dry_run:true. Undeclared verbs
keep fail-closed attempt rows (security property).
"""
import charter.main as main

from charter.sdk import _DRY_RUN
from tests.test_bridge import FakeRequest, _parse


def _run(body, monkeypatch, **seams):
    """Dispatch through main.bridge with faked auth/audit."""
    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "jason", "interface": "cc", "allow": ["*"]})
    monkeypatch.setattr(main, "allowed", lambda caller, verb: True)
    calls = []
    monkeypatch.setattr(main, "record", lambda *a, **k: calls.append((a, k)))
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    for name, fn in seams.items():
        monkeypatch.setattr(main, name, fn)
    return _parse(main.bridge(FakeRequest(body=body))), calls


# --- dispatcher gate --------------------------------------------------------

def test_dry_run_skips_pre_audit_when_declared(monkeypatch):
    """A verb that declares dry_run=True gets no attempt row when body.dry_run is true."""
    monkeypatch.setitem(main.VERBS, "test.dry_verb",
                        (lambda body, caller: {"plan": "would do X"}, "pre"))
    _DRY_RUN.add("test.dry_verb")
    try:
        (body, status), calls = _run({"verb": "test.dry_verb", "dry_run": True}, monkeypatch)
        assert status == 200
        assert body["plan"] == "would do X"
        assert not any(a[3] == "attempt" for a, k in calls)
        # Adversarial review: dry-run executions must be audit-distinguishable
        # from real executions — the post-execution row records "dry_run".
        assert any(a[3] == "dry_run" for a, k in calls)
        assert not any(a[3] == "ok" for a, k in calls)
    finally:
        _DRY_RUN.discard("test.dry_verb")


def test_dry_run_writes_pre_audit_when_not_declared(monkeypatch):
    """A verb that does NOT declare dry_run still writes an attempt row even if
    the caller passes dry_run:true — fail-closed, caller cannot suppress."""
    monkeypatch.setitem(main.VERBS, "test.no_dry_verb",
                        (lambda body, caller: {"ok": True}, "pre"))
    # ensure it is NOT in the declared set
    _DRY_RUN.discard("test.no_dry_verb")
    try:
        (body, status), calls = _run({"verb": "test.no_dry_verb", "dry_run": True}, monkeypatch)
        assert status == 200
        assert any(a[3] == "attempt" for a, k in calls)
    finally:
        pass


def test_dry_run_false_still_writes_pre_audit(monkeypatch):
    """dry_run:false (or absent) on a declared verb still writes the attempt row."""
    monkeypatch.setitem(main.VERBS, "test.dry_verb",
                        (lambda body, caller: {"ok": True}, "pre"))
    _DRY_RUN.add("test.dry_verb")
    try:
        (body, status), calls = _run({"verb": "test.dry_verb"}, monkeypatch)
        assert status == 200
        assert any(a[3] == "attempt" for a, k in calls)
    finally:
        _DRY_RUN.discard("test.dry_verb")


def test_dry_run_on_post_audit_verb_is_no_op(monkeypatch):
    """dry_run on a post-audit verb passes through normally (no pre-audit to skip)."""
    monkeypatch.setitem(main.VERBS, "test.post_verb",
                        (lambda body, caller: {"plan": "read-only"}, "post"))
    _DRY_RUN.add("test.post_verb")
    try:
        (body, status), calls = _run({"verb": "test.post_verb", "dry_run": True}, monkeypatch)
        assert status == 200
        assert body["plan"] == "read-only"
        # post-audit verbs have no attempt row regardless
        assert not any(a[3] == "attempt" for a, k in calls)
    finally:
        _DRY_RUN.discard("test.post_verb")
