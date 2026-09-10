"""improve.report: files a GitHub issue; scope-exempt, not actor-exempt; fail-closed."""
import json
import requests

import charter.main as main
from charter import improve


class FakeRequest:
    def __init__(self, headers=None, body=None):
        self.headers = headers or {}
        self._body = body or {}
    def get_json(self, silent=False):
        return self._body


class FakeResp:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._p = payload
    def json(self):
        return self._p


def _parse(resp):
    body, status, _h = resp
    return json.loads(body), status


def _as_caller(monkeypatch, require_actor=False, allow=("*",), scope_ok=True):
    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "marketer", "interface": "plugin",
                                     "allow": list(allow), "require_actor": require_actor})
    monkeypatch.setattr(main, "allowed", lambda caller, verb: scope_ok)
    monkeypatch.setattr(main, "record", lambda *a, **k: None)


def _enable(monkeypatch):
    import charter.settings as settings_mod
    monkeypatch.setenv("IMPROVE_GITHUB_REPO", "acme/tools")
    monkeypatch.setenv("IMPROVE_GITHUB_TOKEN", "ghp_secret")
    settings_mod.get_settings.cache_clear()


def _capture_post(monkeypatch, status=201, payload=None):
    calls = []
    def fake_post(url, **kw):
        calls.append((url, kw))
        return FakeResp(status, payload if payload is not None else {"html_url": "https://github.com/acme/tools/issues/7", "number": 7})
    monkeypatch.setattr(improve.requests, "post", fake_post)
    return calls


GAP = {"verb": "improve.report", "kind": "gap", "title": "deal.update rejects empty stage",
       "body": "Tried to clear stage; got bad_stage. Worked around by setting 'none'.",
       "context": {"verb": "crm.deal.update", "error_code": "bad_stage", "request_id": "r1",
                   "workaround": "set stage to 'none'"}}


def test_disabled_when_unconfigured(monkeypatch):
    _as_caller(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: "sam@example.com")
    body, status = _parse(main.bridge(FakeRequest(body=GAP)))
    assert status == 503 and body["error"] == "improve_disabled"


def test_gap_files_issue_with_template(monkeypatch):
    _enable(monkeypatch); _as_caller(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: "sam@example.com")
    calls = _capture_post(monkeypatch)
    body, status = _parse(main.bridge(FakeRequest(body=GAP)))
    assert status == 200 and body["ok"] is True
    assert body["issue"].endswith("/issues/7") and body["number"] == 7 and body["target"] == "issue:7"
    url, kw = calls[0]
    assert url == "https://api.github.com/repos/acme/tools/issues"
    assert kw["headers"]["Authorization"] == "Bearer ghp_secret"
    assert kw["timeout"] == 30
    assert kw["json"]["labels"] == ["gap"]
    text = kw["json"]["body"]
    for heading in ("## Reporter\nsam@example.com", "## Kind\ngap", "## Report\n", "## Context\n",
                    "- verb: crm.deal.update", "- error_code: bad_stage", "- workaround: set stage to 'none'"):
        assert heading in text
    assert "## Proposal" not in text


def test_skill_requires_proposal_and_fences_it(monkeypatch):
    _enable(monkeypatch); _as_caller(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    calls = _capture_post(monkeypatch)
    skill = {"verb": "improve.report", "kind": "skill", "title": "weekly digest", "body": "share with team"}
    body, status = _parse(main.bridge(FakeRequest(body=skill)))
    assert status == 400 and body["error"] == "missing_field"
    skill["proposal"] = "# Weekly digest\n\nDo the thing."
    body, status = _parse(main.bridge(FakeRequest(body=skill)))
    assert status == 200
    text = calls[0][1]["json"]["body"]
    assert "## Reporter\nplugin:marketer" in text
    assert "## Proposal\n```markdown\n# Weekly digest" in text
    assert calls[0][1]["json"]["labels"] == ["skill"]


def test_bad_kind_and_missing_fields(monkeypatch):
    _enable(monkeypatch); _as_caller(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    _capture_post(monkeypatch)
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "improve.report", "kind": "bug", "title": "t", "body": "b"})))
    assert status == 400 and body["error"] == "bad_kind"
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "improve.report", "kind": "gap", "title": "t"})))
    assert status == 400 and body["error"] == "missing_field"
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "improve.report", "kind": "gap", "title": "t", "body": "b", "proposal": 5})))
    assert status == 400 and body["error"] == "bad_proposal"


def test_too_large(monkeypatch):
    _enable(monkeypatch); _as_caller(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    calls = _capture_post(monkeypatch)
    big = dict(GAP, proposal="x" * (improve.MAX_BODY_BYTES + 1))
    body, status = _parse(main.bridge(FakeRequest(body=big)))
    assert status == 413 and body["error"] == "too_large" and calls == []


def test_github_failure_maps_to_502_without_token(monkeypatch):
    _enable(monkeypatch); _as_caller(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    _capture_post(monkeypatch, status=401, payload={"message": "Bad credentials"})
    body, status = _parse(main.bridge(FakeRequest(body=GAP)))
    assert status == 502 and body["error"] == "github_error"
    assert "ghp_secret" not in json.dumps(body)


def test_github_unreachable_maps_to_502(monkeypatch):
    _enable(monkeypatch); _as_caller(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    def boom(url, **kw):
        raise requests.Timeout("read timed out")
    monkeypatch.setattr(improve.requests, "post", boom)
    body, status = _parse(main.bridge(FakeRequest(body=GAP)))
    assert status == 502 and body["error"] == "github_error"
    assert "ghp_secret" not in json.dumps(body)


def test_github_201_with_unexpected_body_maps_to_502(monkeypatch):
    _enable(monkeypatch); _as_caller(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    _capture_post(monkeypatch, status=201, payload={})
    body, status = _parse(main.bridge(FakeRequest(body=GAP)))
    assert status == 502 and body["error"] == "github_error"
    assert "ghp_secret" not in json.dumps(body)


def test_too_large_title_counts_toward_limit(monkeypatch):
    _enable(monkeypatch); _as_caller(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    calls = _capture_post(monkeypatch)
    big_title = dict(GAP, title="x" * (improve.MAX_BODY_BYTES + 1))
    body, status = _parse(main.bridge(FakeRequest(body=big_title)))
    assert status == 413 and body["error"] == "too_large" and calls == []


def test_scope_exempt_but_not_actor_exempt(monkeypatch):
    _enable(monkeypatch)
    _as_caller(monkeypatch, allow=(), scope_ok=False)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    _capture_post(monkeypatch)
    # scope: a caller allowed nothing can still report
    body, status = _parse(main.bridge(FakeRequest(body=GAP)))
    assert status == 200
    # ...but the same caller is still denied other verbs
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "identity.whoami"})))
    assert status == 403 and body["error"] == "denied"
    # actor: a require_actor key with no human behind it cannot report
    _as_caller(monkeypatch, require_actor=True, allow=(), scope_ok=False)
    body, status = _parse(main.bridge(FakeRequest(body=GAP)))
    assert status == 401 and body["error"] == "actor_required"


def test_no_audit_row_before_validation(monkeypatch):
    """Audit policy is post: a hostile title must not reach an attempt row."""
    _enable(monkeypatch); _as_caller(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    rows = []
    monkeypatch.setattr(main, "record", lambda caller, verb, target, result, **k: rows.append((result, target)))
    _capture_post(monkeypatch)
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "improve.report", "kind": "bug",
                                                        "title": "x" * 100_000, "body": "b"})))
    assert status == 400
    assert [r for r, _ in rows] == ["bad_kind"]          # one post row, no "attempt"
    assert all(t is None or len(t) < 200 for _, t in rows)


def test_listed_for_everyone_and_is_write(monkeypatch):
    _as_caller(monkeypatch, allow=(), scope_ok=False)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "verbs.list"})))
    assert status == 200
    assert body["verbs"]["improve.report"]["read"] is False
    assert body["verbs"]["improve.report"]["summary"]
