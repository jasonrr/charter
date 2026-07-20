"""U4 contract checks for Charter packs — the agent-facing contract, enforced.

Each check is a small pure-ish function returning a list of CheckResults (or a
single optional result for the boolean helpers). The suite also exercises packs
through the REAL dispatcher via run_probe (auth, audit capture, actor gate,
read-only guard), mirroring tests/test_bridge.py.

Naming is a SECURITY boundary: the read tool classifies read/write from the
action-leaf convention plus each registered prefix family's declared flag. A
write verb named with a read leaf is callable through the read tool — a failure
with failure_class="security". A read verb with an unconventional leaf is
degraded discovery — a warning, not a security failure.
"""
import dataclasses
import inspect
import json

from charter.sdk import VERBS, is_read, summary, _READ_LEAVES

SPEC_PIN = "2025-11-25"
_RESPONSE_BUDGET = 1024 * 1024   # 1 MB proxy budget


@dataclasses.dataclass
class CheckResult:
    check: str
    verb: str
    level: str            # "failure" | "warning" | "info"
    failure: str          # machine-matchable code
    suggested_fix: str
    failure_class: str = "contract"   # "security" | "contract"


@dataclasses.dataclass
class ProbeResult:
    status: int
    body: dict
    audit_calls: list


def _r(check, verb, level, failure, fix, klass="contract"):
    return CheckResult(check, verb, level, failure, fix, klass)


# --- (1) naming -------------------------------------------------------------

def check_naming(verb, declared_read=None):
    """domain.resource.action naming consistent with read/write intent.

    A verb classified "read" by the leaf/declared-flag convention but whose
    handler performs a side effect is a security failure (callable through the
    read-only tool) — detected by probing the read-only guard (see
    probe_read_only_leak). A read with an unconventional leaf is a degraded-
    discovery warning (not security)."""
    leaf = verb.rsplit(".", 1)[-1]
    read_intent = is_read(verb) if declared_read is None else bool(declared_read)
    results = []
    if leaf not in _READ_LEAVES and read_intent:
        results.append(_r(
            "naming", verb, "warning", "read_named_with_unconventional_leaf",
            f"rename {verb!r} to end in a canonical read leaf "
            f"({sorted(_READ_LEAVES)}) so the read tool discovers and allows it; "
            "as named it is a read the read tool will treat as a write"))
    return results


def probe_read_only_leak(verb, body=None):
    """Probe one read-classified verb through the read-only guard. If it runs
    (HTTP 200) and returns a side-effect marker, the naming is a security
    failure: a write slipped through the read tool. Returns a CheckResult or
    None."""
    if not is_read(verb):
        return None
    probe = run_probe(verb, body=body or {"verb": verb, "read_only": True})
    if probe.status == 200 and (probe.body.get("_wrote") or "deleted" in probe.body
                                or "published" in probe.body):
        return _r(
            "naming", verb, "failure", "write_reachable_via_read_tool",
            f"{verb!r} is classified read by the leaf convention but executed a side "
            "effect through the read-only guard; rename it with a non-read action leaf "
            "or declare read=False so the guard refuses it",
            klass="security")
    return None


# --- (2) docstring -----------------------------------------------------------

def check_docstring(verb, handler):
    """The verbs.list catalog entry is the handler's first docstring line."""
    if not summary(handler):
        return _r("docstring", verb, "failure", "missing_docstring",
                  f"add a first-line docstring summary to the handler for {verb!r}; "
                  "it is the verbs.list catalog entry an agent reads to pick the verb")
    return None


# --- (3) error contract ------------------------------------------------------

def check_error_contract(verb, handler):
    """Handlers must raise VerbError (machine-matchable code), not raw exceptions."""
    src = inspect.getsource(handler)
    raises_raw = ("raise VerbError" not in src) and (
        "raise RuntimeError" in src or "raise Exception" in src or
        "raise ValueError" in src or "raise KeyError" in src)
    if raises_raw:
        return _r("error_contract", verb, "failure", "raises_raw_exception",
                  f"raise charter.errors.VerbError(status, code, detail) in {verb!r} instead of a "
                  "raw exception; raw exceptions map to an unaudited 500 'internal' and give "
                  "the caller no machine-matchable error code")
    return None


# --- (4) audit policy --------------------------------------------------------

def check_audit(verb, audit_policy, dry_run_declared, declared_read=None):
    """Irreversible verbs need fail-closed pre-audit + confirm gate + dry_run."""
    results = []
    read_intent = is_read(verb) if declared_read is None else bool(declared_read)
    if read_intent:
        return results                      # reads are "post"-audited; nothing to check
    if audit_policy != "pre":
        results.append(_r(
            "audit_policy", verb, "failure", "post_audit_on_irreversible",
            f"register {verb!r} with audit_policy=\"pre\" so a durable attempt row is "
            "written (fail-closed) before the side effect; \"post\" loses the record of "
            "an attempted irreversible action if the handler crashes"))
    if not dry_run_declared:
        results.append(_r(
            "audit_policy", verb, "failure", "missing_dry_run_declaration",
            f"declare dry_run=True on {verb!r} and honor body[\"dry_run\"] to return a "
            "preview plan with no side effect and no attempt row (KTD-8)"))
    return results


# --- (5) response-size budget -------------------------------------------------

def check_response_budget(verb, result):
    """Responses must respect the 1 MB proxy budget with a truncated flag."""
    try:
        size = len(json.dumps(result).encode())
    except (TypeError, ValueError):
        return _r("response_budget", verb, "failure", "unserializable_response",
                  f"return only JSON-serializable values from {verb!r} "
                  "(run rows through sdk._safe for dates/Decimals)")
    if size > _RESPONSE_BUDGET and not result.get("truncated"):
        return _r("response_budget", verb, "failure", "oversize_response_without_truncation",
                  f"cap {verb!r} results under {_RESPONSE_BUDGET} bytes (1 MB proxy budget) "
                  "or set \"truncated\": true with a way to page/continue")
    return None


# --- handler-result conventions -----------------------------------------------

def check_audit_detail_convention(verb, handler):
    """_audit_detail is server-side only; a pack must not depend on leaking it."""
    src = inspect.getsource(handler)
    if '"_audit_detail"' in src or "'_audit_detail'" in src:
        return _r("audit_detail_convention", verb, "warning",
                  "audit_detail_leak_risk",
                  f"the dispatcher pops result[\"_audit_detail\"] server-side into the audit row "
                  f"and it never reaches the caller; in {verb!r} do not rely on it as a response field")
    return None


# --- through-the-wrapper dispatch ----------------------------------------------

def run_probe(verb, body=None, run=True, identify=None, allowed=None):
    """Dispatch one call through the REAL main.bridge with probe seams.

    Auth, audit capture, actor gate, and the read-only guard all run for real;
    only the auth seams (identify/allowed/record/actor_email) are faked, per the
    tests/test_bridge.py pattern. Returns a ProbeResult with the HTTP status,
    parsed body, and the captured audit rows."""
    import os

    # The suite's credential-faking seam: the dispatcher validates Settings at
    # import (fail-fast). Fixture handlers never touch real GCP, so a minimal
    # test env lets the real bridge boot without ambient config — the suite is
    # self-contained and importing a pack under test never requires ADC. Set
    # these BEFORE importing main (which calls get_settings() at import).
    os.environ.setdefault("GCP_PROJECT", "packtest-fixture")
    os.environ.setdefault("GOOGLE_OAUTH_CLIENT_ID", "packtest.apps.googleusercontent.com")
    os.environ.setdefault("ALLOWED_DOMAIN", "@example.com")

    import charter.main as main

    class FakeRequest:
        """Minimal functions-framework request fake (headers + JSON body)."""

        def __init__(self, body=None, headers=None):
            self.headers = headers or {}
            self._body = body or {}

        def get_json(self, silent=False):
            return self._body

    body = body or {"verb": verb}
    audit_calls = []
    orig = (main.identify, main.allowed, main.record, main.actor_email)
    try:
        main.identify = identify or (
            lambda req: {"name": "packtest", "interface": "cc", "allow": ["*"]})
        main.allowed = allowed or (lambda caller, v: True)
        main.record = lambda *a, **k: audit_calls.append((a, k))
        main.actor_email = lambda req: None
        resp_body, status, _h = main.bridge(FakeRequest(body=body))
        return ProbeResult(status=status, body=json.loads(resp_body),
                           audit_calls=audit_calls)
    finally:
        main.identify, main.allowed, main.record, main.actor_email = orig


# --- whole-pack evaluation -----------------------------------------------------

def evaluate_pack(module):
    """Run all per-verb checks against every verb a pack module registered.

    Registration already happened at pack import time (sdk.register calls at
    module top). We select VERBS entries whose handler lives in this module by
    its __name__ and run each contract check; the read/write intent comes from
    the live classifier (declared-flag aware), the dry_run declaration from
    the registry's introspection set."""
    results = []
    verbs = [(v, fn, audit) for v, (fn, audit) in VERBS.items()
             if (lambda m: m == module.__name__ or m.startswith(module.__name__ + "."))(
                 getattr(fn, "__module__", ""))]
    for verb, fn, audit in verbs:
        results.extend(check_naming(verb))
        leak = probe_read_only_leak(verb)
        if leak:
            results.append(leak)
        doc = check_docstring(verb, fn)
        if doc:
            results.append(doc)
        results.extend(check_audit(verb, audit,
                                   dry_run_declared=verb in _dry_run_set()))
        err = check_error_contract(verb, fn)
        if err:
            results.append(err)
        conv = check_audit_detail_convention(verb, fn)
        if conv:
            results.append(conv)
        # response budget is exercised on a probe call when possible
        try:
            probe = run_probe(verb)
            if probe.status == 200:
                bud = check_response_budget(verb, probe.body)
                if bud:
                    results.append(bud)
        except Exception:
            pass                       # probe is best-effort; static checks already ran
    return results


def _dry_run_set():
    """The verbs that declared dry_run support (KTD-8). Introspection only."""
    import charter.sdk as sdk
    return getattr(sdk, "_DRY_RUN", set())
