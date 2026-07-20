"""Tests for identity_verbs.py (identity.whoami), the request_id envelope,
and the U3 generalizations.
"""
import json


import charter.main as main
from charter.sdk import is_read


class FakeRequest:
    def __init__(self, headers=None, body=None):
        self.headers = headers or {}
        self._body = body or {}

    def get_json(self, silent=False):
        return self._body


def _parse(resp):
    body, status, _headers = resp
    return json.loads(body), status


def _as_caller(monkeypatch, require_actor=False, allow=("*",)):
    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "marketer", "interface": "plugin",
                                     "allow": list(allow),
                                     "require_actor": require_actor})
    monkeypatch.setattr(main, "allowed", lambda caller, verb: True)
    monkeypatch.setattr(main, "record", lambda *a, **k: None)


# --- identity.whoami ------------------------------------------------------------

def test_whoami_with_actor_returns_own_auth_surface(monkeypatch):
    _as_caller(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: "sam@example.com")
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "identity.whoami"})))
    assert status == 200
    assert body["ok"] is True
    assert body["caller"] == "marketer"
    assert body["actor"] == "sam@example.com"
    assert body["scopes"] == ["*"]
    assert body["credential_mode"] == "user:sam@example.com"


def test_whoami_without_actor_is_machine_shape(monkeypatch):
    _as_caller(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "identity.whoami"})))
    assert status == 200
    assert body["actor"] is None
    assert body["credential_mode"] == "app"
    assert body["caller"] == "marketer"
    assert body["scopes"] == ["*"]


def test_whoami_is_read_and_passes_the_read_only_guard(monkeypatch):
    assert is_read("identity.whoami") is True
    _as_caller(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    body, status = _parse(main.bridge(
        FakeRequest(body={"verb": "identity.whoami", "read_only": True})))
    assert status == 200


def test_whoami_discoverable_via_verbs_list(monkeypatch):
    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "cron", "interface": "cron",
                                     "allow": ["identity.*"]})
    monkeypatch.setattr(main, "allowed",
                        lambda caller, verb: verb.startswith("identity."))
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    monkeypatch.setattr(main, "record", lambda *a, **k: None)
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "verbs.list"})))
    assert status == 200
    assert body["verbs"]["identity.whoami"]["read"] is True
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "identity.whoami"})))
    assert status == 200
    assert body["caller"] == "cron"


# --- request_id in every envelope ------------------------------------------------

def test_request_id_on_success_matches_audit_row(monkeypatch):
    _as_caller(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    calls = []
    monkeypatch.setattr(main, "record", lambda *a, **k: calls.append((a, k)))
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "identity.whoami"})))
    assert status == 200
    assert "request_id" in body
    ok = [(a, k) for a, k in calls if a[3] == "ok"][0]
    assert ok[1]["rid"] == body["request_id"]


def test_request_id_on_verberror_matches_audit_row(monkeypatch):
    _as_caller(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    calls = []
    monkeypatch.setattr(main, "record", lambda *a, **k: calls.append((a, k)))

    def raising_handler(body, caller):
        raise main.VerbError(404, "doc_not_found", "x")

    monkeypatch.setitem(main.VERBS, "docs.report.read", (raising_handler, "post"))
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "docs.report.read"})))
    assert status == 404
    assert body["error"] == "doc_not_found"
    assert "request_id" in body
    err = [(a, k) for a, k in calls if a[3] == "doc_not_found"][0]
    assert err[1]["rid"] == body["request_id"]


def test_request_id_on_business_rejection_and_internal_error(monkeypatch):
    _as_caller(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    monkeypatch.setattr(main, "record", lambda *a, **k: None)
    monkeypatch.setitem(main.VERBS, "sync.status",
                        (lambda body, caller: {"ok": False, "error": "confirm_required"}, "post"))
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "sync.status"})))
    assert status == 400
    assert "request_id" in body

    def boom(body, caller):
        raise RuntimeError("x")
    monkeypatch.setitem(main.VERBS, "sync.status", (boom, "post"))
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "sync.status"})))
    assert status == 500
    assert body["error"] == "internal"
    assert "request_id" in body


def test_request_id_on_gate_refusals(monkeypatch):
    # denied / unknown_verb / actor_required / actor_invalid all carry request_id
    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "cron", "interface": "cron",
                                     "allow": ["sync."], "require_actor": True})
    monkeypatch.setattr(main, "allowed", lambda caller, verb: False)
    monkeypatch.setattr(main, "record", lambda *a, **k: None)
    body, status = _parse(main.bridge(
        FakeRequest(body={"verb": "cms.page.publish"})))
    assert status == 403 and "request_id" in body

    monkeypatch.setattr(main, "actor_email", lambda req: None)
    monkeypatch.setattr(main, "allowed", lambda caller, verb: True)
    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "cron", "interface": "cron",
                                     "allow": ["sync."], "require_actor": False})
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "nope.verb"})))
    assert status == 404 and "request_id" in body

    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "marketer", "interface": "plugin",
                                     "allow": ["*"], "require_actor": True})
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "sync.status"})))
    assert status == 401 and body["error"] == "actor_required"
    assert "request_id" in body

    def bad(req):
        raise main.VerbError(401, "actor_invalid", "identity token rejected: expired")
    monkeypatch.setattr(main, "actor_email", bad)
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "sync.status"})))
    assert status == 401 and body["error"] == "actor_invalid"
    assert "request_id" in body


# --- actor gate characterization (unchanged behavior) ----------------------------

def test_bad_actor_token_still_401(monkeypatch):
    _as_caller(monkeypatch)

    def bad(req):
        raise main.VerbError(401, "actor_invalid", "identity token rejected (ValueError)")
    monkeypatch.setattr(main, "actor_email", bad)
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "identity.whoami"})))
    assert status == 401
    assert body["error"] == "actor_invalid"


def test_missing_actor_on_require_actor_key_still_401(monkeypatch):
    _as_caller(monkeypatch, require_actor=True)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "identity.whoami"})))
    assert status == 401
    assert body["error"] == "actor_required"
