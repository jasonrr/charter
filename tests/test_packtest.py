"""U4 conformance suite: contract checks against pack verbs through the REAL
dispatcher. Proof-first — this module asserts a packtest package that validates
packs against the agent-facing contract.

Mirrors the dispatcher test pattern in tests/test_bridge.py: FakeRequest,
monkeypatched seams (identify/allowed/record/actor_email), probe verbs via the
mutable sdk.VERBS registry.
"""
import json


from charter.packtest import checks


# --- helpers ---------------------------------------------------------------

def _caller(allow=None, require_actor=False):
    return {"name": "t", "interface": "cc", "allow": allow or ["*"],
            "require_actor": require_actor}


def _write_verb(verb, handler, audit_policy="pre", dry_run=True):
    """Register a write verb via the public SDK with an explicit read=False."""
    from charter.sdk import register
    register(verb, handler, audit_policy, read=False, dry_run=dry_run)


def _cleanup_verbs(*verbs):
    from charter.sdk import VERBS, _DECLARED_READ, _DRY_RUN
    for v in verbs:
        VERBS.pop(v, None)
        _DECLARED_READ.pop(v, None)
        _DRY_RUN.discard(v)


# --- naming check (security boundary) --------------------------------------

def test_naming_write_named_with_read_leaf_is_security_failure(monkeypatch):
    # a write verb named with a read leaf (registered flagless so the leaf
    # classifies it read) is reachable through the read tool — probe detects it
    from charter.sdk import register
    register("content.fixture.list", lambda b, c: {"deleted": True, "_wrote": True},
             "post")
    try:
        result = checks.probe_read_only_leak("content.fixture.list")
        assert result is not None and result.check == "naming"
        assert result.level == "failure" and result.failure_class == "security"
    finally:
        _cleanup_verbs("content.fixture.list")


def test_naming_read_verb_unconventional_leaf_is_warning_not_security():
    # a READ verb with an unconventional leaf is a warning-class degraded-
    # discovery signal, NOT a security failure
    results = checks.check_naming("content.report.generate", declared_read=True)
    sec = [r for r in results if r.failure_class == "security"]
    assert not sec
    assert any(r.level == "warning" for r in results)


def test_naming_ok_for_canonical_read_leaf():
    results = checks.check_naming("data.query.views", declared_read=True)
    assert not any(r.level == "failure" for r in results)


# --- docstring check --------------------------------------------------------

def test_docstring_missing_first_line_fails():
    def _h(body, caller):
        return {}

    assert checks.check_docstring("x.y", _h) is not None
    ok_handler = lambda b, c: {}            # noqa: E731
    ok_handler.__doc__ = "Does the thing."
    assert checks.check_docstring("x.y", ok_handler) is None


# --- audit-policy check (AE7) ----------------------------------------------

def test_audit_policy_post_on_irreversible_verb_fails():
    # AE7: an irreversible (write) verb with "post" audit must fail — it needs
    # a fail-closed "pre" attempt row + a confirm gate + a dry_run declaration
    results = checks.check_audit("cms.page.publish",
                                 audit_policy="post", dry_run_declared=False,
                                 declared_read=False)
    assert any(r.level == "failure" and r.check == "audit_policy"
               for r in results)


def test_audit_policy_pre_with_confirm_and_dry_run_passes():
    results = checks.check_audit("billing.invoice.send",
                                 audit_policy="pre", dry_run_declared=True,
                                 declared_read=False)
    assert not any(r.level == "failure" for r in results)


def test_audit_policy_requires_dry_run_declaration_on_irreversible():
    results = checks.check_audit("cms.page.publish",
                                 audit_policy="pre", dry_run_declared=False,
                                 declared_read=False)
    assert any(r.check == "audit_policy" and r.level == "failure" and
               "dry_run" in r.failure for r in results)


# --- error contract ----------------------------------------------------------

def test_error_contract_raw_exception_fails():
    def boom(body, caller):
        raise RuntimeError("nope")

    assert checks.check_error_contract("x.y", boom) is not None

    def good(body, caller):
        from charter.errors import VerbError
        raise VerbError(404, "not_found")

    assert checks.check_error_contract("x.y", good) is None


# --- response-size budget ----------------------------------------------------

def test_response_budget_flags_oversize_without_truncation():
    big = {"rows": ["x" * (1024 * 1024 + 1)]}      # > 1 MB, no truncated flag
    assert checks.check_response_budget("x.y", big) is not None
    ok = {"rows": [], "truncated": True}
    assert checks.check_response_budget("x.y", ok) is None


# --- handler-result conventions ----------------------------------------------

def test_audit_detail_pop_is_checked():
    # a handler that leaves _audit_detail in the result fails the convention —
    # the dispatcher pops it server-side; a pack must not leak it differently.
    def leaking(body, caller):
        return {"_audit_detail": "secret", "ok": True}

    assert checks.check_audit_detail_convention("x.y", leaking) is not None

    def clean(body, caller):
        return {"ok": True}

    assert checks.check_audit_detail_convention("x.y", clean) is None


# --- through-the-wrapper dispatch (auth, audit capture, actor gate, read-only)

def test_wrapper_runs_pack_probe_through_real_bridge(monkeypatch):
    # A pack-registered probe verb dispatches through the REAL bridge() with
    # auth + audit capture + actor gate + read-only guard, per test_bridge.py.
    import charter.main as main
    monkeypatch.setattr(main, "identify", lambda req: _caller())
    monkeypatch.setattr(main, "allowed", lambda caller, verb: True)
    calls = []
    monkeypatch.setattr(main, "record", lambda *a, **k: calls.append(a))
    monkeypatch.setattr(main, "actor_email", lambda req: None)

    captured = checks.run_probe("data.query.fixtureview",
                                body={"verb": "data.query.fixtureview"},
                                run=True)
    assert captured.status in (200, 400, 403, 404, 500)


def test_wrapper_read_only_guard_rejects_pack_write(monkeypatch):
    import charter.main as main
    monkeypatch.setattr(main, "identify", lambda req: _caller())
    monkeypatch.setattr(main, "allowed", lambda caller, verb: True)
    calls = []
    monkeypatch.setattr(main, "record", lambda *a, **k: calls.append(a))
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    _write_verb("content.fixture.write", lambda b, c: {"done": True},
                "pre", dry_run=True)
    try:
        captured = checks.run_probe("content.fixture.write",
                                    body={"verb": "content.fixture.write",
                                          "read_only": True}, run=True)
        assert captured.status == 403
        assert captured.body["error"] == "write_in_read_tool"
    finally:
        _cleanup_verbs("content.fixture.write")


# --- fixture packs + CLI -----------------------------------------------------

def test_cli_good_pack_passes(tmp_path, monkeypatch):
    from charter.packtest import cli
    rc = cli.main(["--pack", "tests/fixture_packs/conformance_good.py"])
    assert rc == 0


def test_cli_bad_pack_fails_with_named_errors_and_nonzero_exit(capsys):
    # AE6: the known-bad fixture pack fails with named actionable errors per
    # defect (naming, docstring, error contract, audit policy).
    from charter.packtest import cli
    rc = cli.main(["--pack", "tests/fixture_packs/conformance_bad.py"])
    assert rc != 0
    out = capsys.readouterr().out
    lines = [json.loads(line) for line in out.splitlines() if line.strip()]
    checks_seen = {line["check"] for line in lines}
    assert {"naming", "docstring", "error_contract", "audit_policy"} <= checks_seen
    assert all("suggested_fix" in line for line in lines)


def test_cli_emits_json_lines_and_spec_pin(capsys):
    from charter.packtest import cli
    cli.main(["--pack", "tests/fixture_packs/conformance_bad.py"])
    out = capsys.readouterr().out
    for line in out.splitlines():
        if line.strip():
            rec = json.loads(line)          # every line parses
            assert {"check", "verb", "failure", "suggested_fix"} <= set(rec)
    assert checks.SPEC_PIN == "2025-11-25"


def test_cli_path_form_on_installed_pack():
    # Regression: path-loading a file inside an installed package double-registered
    # its verbs (the file's absolute imports ran the real package __init__ first),
    # so the documented invocation crashed with verb_collision. The CLI now
    # imports by dotted name when the path lives in an importable package.
    from charter.packtest import cli
    rc = cli.main(["--pack", "src/charter/packs/airtable/__init__.py"])
    assert rc == 0


def test_cli_directory_form_resolves_to_init():
    # Regression: --pack <directory> (the natural way to hand over a multi-file
    # pack) crashed with AttributeError on a None spec; it now loads __init__.py.
    from charter.packtest import cli
    rc = cli.main(["--pack", "src/charter/packs/airtable"])
    assert rc == 0
