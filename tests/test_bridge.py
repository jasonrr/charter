import json

import charter.main as main
import charter.auth as auth


class FakeRequest:
    def __init__(self, headers=None, body=None):
        self.headers = headers or {}
        self._body = body or {}

    def get_json(self, silent=False):
        return self._body


def _parse(resp):
    body, status, _headers = resp
    return json.loads(body), status


def test_unauthorized_when_no_key(monkeypatch):
    monkeypatch.setattr(main, "identify", lambda req: None)
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "sync.status"})))
    assert status == 401
    assert body["error"] == "unauthorized"


def test_denied_when_out_of_scope(monkeypatch):
    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "cron", "interface": "cron", "allow": ["sync."]})
    monkeypatch.setattr(main, "allowed", lambda caller, verb: False)
    recorded = []
    monkeypatch.setattr(main, "record", lambda *a, **k: recorded.append((a, k)))
    body, status = _parse(main.bridge(
        FakeRequest(body={"verb": "cms.page.publish"})))
    assert status == 403
    assert body["error"] == "denied"
    assert recorded  # denial was audited


def test_unknown_verb(monkeypatch):
    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "jason", "interface": "cc", "allow": ["*"]})
    monkeypatch.setattr(main, "allowed", lambda caller, verb: True)
    monkeypatch.setattr(main, "record", lambda *a, **k: None)
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "nope.verb"})))
    assert status == 404
    assert body["error"] == "unknown_verb"


def test_verbs_list_ok_and_audited(monkeypatch):
    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "jason", "interface": "cc", "allow": ["*"]})
    monkeypatch.setattr(main, "allowed", lambda caller, verb: True)
    calls = []
    monkeypatch.setattr(main, "record", lambda *a, **k: calls.append(a))
    monkeypatch.setitem(main.VERBS, "sync.status",
                        (lambda body, caller: {"healthy": True, "syncs": []}, "post"))
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "verbs.list"})))
    assert status == 200
    assert body["ok"] is True
    assert "verbs" in body
    assert any(a[3] == "ok" for a in calls)  # an "ok" row was recorded


def test_business_rejection_returns_400_and_audited(monkeypatch):
    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "jason", "interface": "cc", "allow": ["*"]})
    monkeypatch.setattr(main, "allowed", lambda caller, verb: True)
    calls = []
    monkeypatch.setattr(main, "record", lambda *a, **k: calls.append(a))
    monkeypatch.setitem(main.VERBS, "sync.status",
                        (lambda body, caller: {"ok": False, "error": "confirm_required"}, "post"))
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "sync.status"})))
    assert status == 400
    assert body["ok"] is False
    assert body["error"] == "confirm_required"
    assert any(a[3] == "rejected" for a in calls)
    assert not any(a[3] == "ok" for a in calls)


def test_pre_audit_failure_returns_503(monkeypatch):
    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "jason", "interface": "cc", "allow": ["*"]})
    monkeypatch.setattr(main, "allowed", lambda caller, verb: True)

    def failing_record(caller, verb, target, result, rid, detail=None, fail_open=True,
                       on_behalf_of=None):
        if not fail_open:
            raise RuntimeError("bq down")

    monkeypatch.setattr(main, "record", failing_record)
    # register a fake fail-closed verb so the "pre" path is exercised
    monkeypatch.setitem(main.VERBS, "cms.page.publish",
                        (lambda body, caller: {"published": True}, "pre"))
    body, status = _parse(main.bridge(FakeRequest(
        body={"verb": "cms.page.publish", "email_id": "1", "confirm": True})))
    assert status == 503
    assert body["error"] == "audit_unavailable"


def test_admin_reload_keys(monkeypatch):
    # the admin.reload_keys verb forces a live key re-read and is audited
    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "jason", "interface": "cc", "allow": ["*"]})
    monkeypatch.setattr(main, "allowed", lambda caller, verb: True)
    monkeypatch.setattr(main, "record", lambda *a, **k: None)
    hits = {"n": 0}
    monkeypatch.setattr(main, "reload_keys", lambda: hits.__setitem__("n", hits["n"] + 1))
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "admin.reload_keys"})))
    assert status == 200
    assert body["ok"] is True and body["reloaded"] is True
    assert hits["n"] == 1


def test_verberror_maps_to_status_and_audits(monkeypatch):
    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "jason", "interface": "cc", "allow": ["*"]})
    monkeypatch.setattr(main, "allowed", lambda caller, verb: True)
    calls = []
    monkeypatch.setattr(main, "record", lambda *a, **k: calls.append(a))

    def raising_handler(body, caller):
        raise main.VerbError(404, "doc_not_found", "x")

    monkeypatch.setitem(main.VERBS, "docs.report.read", (raising_handler, "post"))
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "docs.report.read"})))
    assert status == 404
    assert body["error"] == "doc_not_found"
    assert body["detail"] == "x"
    assert any(a[3] == "doc_not_found" for a in calls)


def test_target_synthesizes_hubspot_id():
    assert main._target({"verb": "cms.page.publish", "id": "123"}) == "123"
    assert main._target({"target": "explicit"}) == "explicit"


def test_target_prefix_applied_when_registered():
    # A verb registered with target_prefix gets prefixed audit targets; an
    # unregistered verb (or one without a prefix) keeps the raw id.
    from charter import sdk as _sdk
    _sdk._TARGET_PREFIXES["demo.prefixed.write"] = "demo_thing"
    try:
        assert main._target({"verb": "demo.prefixed.write", "id": "123"}) == "demo_thing:123"
        assert main._target({"verb": "demo.unprefixed.write", "id": "123"}) == "123"
    finally:
        del _sdk._TARGET_PREFIXES["demo.prefixed.write"]


# --- actor identity (verified human behind the key) ---------------------------

def _as_marketer(monkeypatch, require_actor=True):
    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "marketer", "interface": "plugin",
                                     "allow": ["*"], "require_actor": require_actor})
    monkeypatch.setattr(main, "allowed", lambda caller, verb: True)


def test_actor_required_when_flagged_and_absent(monkeypatch):
    _as_marketer(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    calls = []
    monkeypatch.setattr(main, "record", lambda *a, **k: calls.append((a, k)))
    monkeypatch.setitem(main.VERBS, "sync.status",
                        (lambda body, caller: {"healthy": True}, "post"))
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "sync.status"})))
    assert status == 401
    assert body["error"] == "actor_required"
    assert any(a[3] == "actor_required" for a, k in calls)


def test_verbs_list_exempt_from_actor_gate(monkeypatch):
    # Discovery is pre-login: a require_actor key with no actor can still list
    # its toolbox (so an agent knows to sign in). Backs INSTALL.md Step 5.
    _as_marketer(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    monkeypatch.setattr(main, "record", lambda *a, **k: None)
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "verbs.list"})))
    assert status == 200
    assert body["ok"] is True


def test_actor_optional_when_not_flagged(monkeypatch):
    _as_marketer(monkeypatch, require_actor=False)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    monkeypatch.setattr(main, "record", lambda *a, **k: None)
    monkeypatch.setitem(main.VERBS, "sync.status",
                        (lambda body, caller: {"healthy": True}, "post"))
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "sync.status"})))
    assert status == 200


def test_actor_invalid_maps_401_even_unflagged(monkeypatch):
    _as_marketer(monkeypatch, require_actor=False)

    def bad(req):
        raise main.VerbError(401, "actor_invalid", "identity token rejected: expired")
    monkeypatch.setattr(main, "actor_email", bad)
    calls = []
    monkeypatch.setattr(main, "record", lambda *a, **k: calls.append((a, k)))
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "sync.status"})))
    assert status == 401
    assert body["error"] == "actor_invalid"
    assert any(a[3] == "actor_invalid" for a, k in calls)


def test_dispatcher_begins_identity_context(monkeypatch):
    _as_marketer(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: "sam@example.com")
    monkeypatch.setattr(main, "record", lambda *a, **k: None)
    seen = {}

    def fake_verb(body, caller):
        from charter import identity_context
        seen.update(identity_context.current())
        return {"healthy": True}
    monkeypatch.setitem(main.VERBS, "sync.status", (fake_verb, "post"))
    body, status = _parse(main.bridge(FakeRequest(
        body={"verb": "sync.status", "allow_shared_credential": True})))
    assert status == 200
    assert seen["actor"] == "sam@example.com"
    assert seen["allow_shared"] is True


def test_credential_merged_into_result(monkeypatch):
    _as_marketer(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: "sam@example.com")
    monkeypatch.setattr(main, "record", lambda *a, **k: None)

    def fake_verb(body, caller):
        from charter import identity_context
        identity_context.current()["credential_used"] = "user:sam@example.com"
        return {"hubspot_id": "1"}
    monkeypatch.setitem(main.VERBS, "sync.status", (fake_verb, "post"))
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "sync.status"})))
    assert status == 200
    assert body["credential"] == "user:sam@example.com"


def test_read_only_flag_rejects_write_verb(monkeypatch):
    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "jason", "interface": "cc", "allow": ["*"]})
    monkeypatch.setattr(main, "allowed", lambda caller, verb: True)
    calls = []
    monkeypatch.setattr(main, "record", lambda *a, **k: calls.append(a))
    monkeypatch.setitem(main.VERBS, "content.hs_post.draft",
                        (lambda body, caller: {"drafted": True}, "post"))
    body, status = _parse(main.bridge(
        FakeRequest(body={"verb": "content.hs_post.draft", "read_only": True})))
    assert status == 403
    assert body["error"] == "write_in_read_tool"
    assert any(a[3] == "write_in_read_tool" for a in calls)


def test_read_only_flag_allows_read_verb(monkeypatch):
    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "jason", "interface": "cc", "allow": ["*"]})
    monkeypatch.setattr(main, "allowed", lambda caller, verb: True)
    monkeypatch.setattr(main, "record", lambda *a, **k: None)
    monkeypatch.setitem(main.VERBS, "sync.status",
                        (lambda body, caller: {"healthy": True}, "post"))
    body, status = _parse(main.bridge(
        FakeRequest(body={"verb": "sync.status", "read_only": True})))
    assert status == 200
    assert body["ok"] is True


def test_is_read_classification():
    # convention-based: read leaves + prefix families read; writes not
    assert main._is_read("sync.status")
    assert main._is_read("docs.report.read")
    assert not main._is_read("content.hs_post.draft")


# --- verbs.list --------------------------------------------------------------

# verbs.list is a discovery primitive: always callable, but reveals ONLY the
# caller's verbs. These use the REAL main.allowed (auth fnmatch), so the
# caller's allow-list drives the filtering.
def _verbs_list_as(monkeypatch, allow):
    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "t", "interface": "cc", "allow": allow})
    monkeypatch.setattr(main, "record", lambda *a, **k: None)
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "verbs.list"})))
    assert status == 200 and body["ok"] is True
    return body["verbs"]


def test_verbs_list_filters_to_caller_scope(monkeypatch):
    verbs = _verbs_list_as(monkeypatch, ["identity."])
    assert "identity.whoami" in verbs and "verbs.list" in verbs
    assert "admin.reload_keys" not in verbs
    assert "data.warehouse.*" not in verbs


def test_verbs_list_always_callable_even_with_no_scope(monkeypatch):
    assert list(_verbs_list_as(monkeypatch, [])) == ["verbs.list"]


def test_verbs_list_includes_prefix_family_when_scoped(monkeypatch):
    verbs = _verbs_list_as(monkeypatch, ["data.warehouse.*"])
    assert "data.warehouse.*" in verbs
    assert verbs["data.warehouse.*"]["read"] is True


# --- request_id --------------------------------------------------------------

def test_request_id_on_success(monkeypatch):
    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "jason", "interface": "cc", "allow": ["*"]})
    monkeypatch.setattr(main, "allowed", lambda caller, verb: True)
    monkeypatch.setattr(main, "record", lambda *a, **k: None)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "verbs.list"})))
    assert status == 200
    assert "request_id" in body


def test_request_id_on_gate_refusals(monkeypatch):
    monkeypatch.setattr(main, "identify", lambda req: None)
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "verbs.list"})))
    assert status == 401 and "request_id" in body

    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "cron", "interface": "cron", "allow": ["sync."]})
    monkeypatch.setattr(main, "allowed", lambda caller, verb: False)
    monkeypatch.setattr(main, "record", lambda *a, **k: None)
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "admin.reload_keys"})))
    assert status == 403 and "request_id" in body


# --- OAuth caller: scope derived from verified actor identity (grants) -------

def test_oauth_caller_derived_when_no_api_key(monkeypatch):
    # No API key, but a verified actor whose email holds a grant.
    monkeypatch.setattr(main, "identify", lambda req: None)
    monkeypatch.setattr(main, "identify_by_actor",
                        lambda req: ({"name": "jason@example.com", "interface": "oauth",
                                      "allow": ["*"], "require_actor": False},
                                     "jason@example.com"))
    monkeypatch.setattr(main, "actor_email", lambda req: "jason@example.com")
    monkeypatch.setattr(main, "record", lambda *a, **k: None)
    monkeypatch.setitem(main.VERBS, "sync.status",
                        (lambda body, caller: {"healthy": True}, "post"))
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "sync.status"})))
    assert status == 200
    assert body["ok"] is True


def test_no_key_no_grant_is_401(monkeypatch):
    # Fail-closed: no API key and no grant -> unauthorized.
    monkeypatch.setattr(main, "identify", lambda req: None)
    monkeypatch.setattr(main, "identify_by_actor", lambda req: (None, None))
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "sync.status"})))
    assert status == 401
    assert body["error"] == "unauthorized"


def test_api_key_takes_precedence_over_actor(monkeypatch):
    # A valid API key wins; identify_by_actor is not consulted.
    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "cron", "interface": "cron", "allow": ["*"]})
    called = {"n": 0}
    monkeypatch.setattr(main, "identify_by_actor",
                        lambda req: called.__setitem__("n", called["n"] + 1))
    monkeypatch.setattr(main, "allowed", lambda caller, verb: True)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    monkeypatch.setattr(main, "record", lambda *a, **k: None)
    monkeypatch.setitem(main.VERBS, "sync.status",
                        (lambda body, caller: {"healthy": True}, "post"))
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "sync.status"})))
    assert status == 200
    assert called["n"] == 0  # actor derivation skipped when a key is present


def test_oauth_caller_denied_outside_grant(monkeypatch):
    # End-to-end through the REAL identify_by_actor (not monkeypatched): a
    # granted email is denied a verb outside its allow-list, via the real
    # _can/allowed fnmatch check.
    monkeypatch.setattr(main, "identify", lambda req: None)
    monkeypatch.setattr(auth, "actor_email", lambda req: "jason@example.com")
    monkeypatch.setattr(auth, "grants_for", lambda email: ["data.*"])
    monkeypatch.setattr(main, "actor_email", lambda req: "jason@example.com")
    recorded = []
    monkeypatch.setattr(main, "record", lambda *a, **k: recorded.append((a, k)))
    monkeypatch.setitem(main.VERBS, "sync.status",
                        (lambda body, caller: {"healthy": True}, "post"))
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "sync.status"})))
    assert status == 403
    assert body["error"] == "denied"
    assert any(a[3] == "denied" for a, k in recorded)


def test_oauth_caller_attribution_audited(monkeypatch):
    # End-to-end through the REAL identify_by_actor: the audited caller
    # record attributes the OAuth principal correctly (name = email,
    # interface = "oauth").
    monkeypatch.setattr(main, "identify", lambda req: None)
    monkeypatch.setattr(auth, "actor_email", lambda req: "jason@example.com")
    monkeypatch.setattr(auth, "grants_for", lambda email: ["*"])
    monkeypatch.setattr(main, "actor_email", lambda req: "jason@example.com")
    recorded = []
    monkeypatch.setattr(main, "record", lambda *a, **k: recorded.append((a, k)))
    monkeypatch.setitem(main.VERBS, "sync.status",
                        (lambda body, caller: {"healthy": True}, "post"))
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "sync.status"})))
    assert status == 200
    caller = recorded[0][0][0]
    assert caller["name"] == "jason@example.com"
    assert caller["interface"] == "oauth"


def test_shape_invalid_grants_secret_yields_401_not_500(monkeypatch):
    # A shape-invalid grants secret (a malformed entry) must fail closed to a
    # clean 401 through the REAL identify_by_actor -> grants_for chain, never
    # an uncaught 500 -- this part of bridge() sits outside any try/except.
    import charter.grants as grants
    monkeypatch.setattr(main, "identify", lambda req: None)
    monkeypatch.setattr(auth, "actor_email", lambda req: "jason@example.com")
    monkeypatch.setattr(main, "actor_email", lambda req: "jason@example.com")
    monkeypatch.setattr(grants, "_fetch", lambda: {"jason@example.com": "not-a-dict"})
    grants.reload()
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "sync.status"})))
    assert status == 401
    assert body["error"] == "unauthorized"


def test_verified_actor_without_grant_is_audited(monkeypatch):
    # The identity is cryptographically verified -- core knows the email, looked
    # it up, and found no grant. A departed employee still live in Workspace is
    # exactly this case; probing the verb surface must leave evidence.
    monkeypatch.setattr(main, "identify", lambda req: None)
    monkeypatch.setattr(auth, "actor_email", lambda req: "departed@example.com")
    monkeypatch.setattr(auth, "grants_for", lambda email: None)
    recorded = []
    monkeypatch.setattr(main, "record", lambda *a, **k: recorded.append((a, k)))
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "sync.status"})))
    assert status == 401
    assert body["error"] == "unauthorized"      # grant existence stays unleaked
    assert "detail" not in body
    assert [a[3] for a, k in recorded] == ["no_grant"]
    assert recorded[0][0][0]["name"] == "departed@example.com"
    assert recorded[0][0][0]["interface"] == "oauth"


def test_no_actor_token_at_all_writes_no_audit_row(monkeypatch):
    # The counterpart: an unauthenticated request carries no identity to audit,
    # so it must stay a silent 401 (no row per anonymous probe).
    monkeypatch.setattr(main, "identify", lambda req: None)
    monkeypatch.setattr(auth, "actor_email", lambda req: None)
    recorded = []
    monkeypatch.setattr(main, "record", lambda *a, **k: recorded.append((a, k)))
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "sync.status"})))
    assert status == 401 and body["error"] == "unauthorized"
    assert recorded == []


def test_invalid_actor_token_without_key_is_audited(monkeypatch):
    # G4: the keyless path must produce the same audited actor_invalid the key
    # path produces (test_actor_invalid_maps_401_even_unflagged), not collapse
    # forged/replayed/expired tokens into a silent generic 401.
    monkeypatch.setattr(main, "identify", lambda req: None)

    def bad(req):
        raise main.VerbError(401, "actor_invalid", "identity token rejected (ExpiredError)")

    monkeypatch.setattr(auth, "actor_email", bad)
    recorded = []
    monkeypatch.setattr(main, "record", lambda *a, **k: recorded.append((a, k)))
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "sync.status"})))
    assert status == 401
    assert body["error"] == "actor_invalid"
    assert body["detail"] == "identity token rejected (ExpiredError)"
    assert [a[3] for a, k in recorded] == ["actor_invalid"]
    assert recorded[0][1]["detail"] == "identity token rejected (ExpiredError)"


def test_non_string_allow_element_yields_401_not_500(monkeypatch):
    # Same shape of hand-edit typo, one level deeper: `[["*"]]` for `["*"]`.
    # allowed() calls .endswith on each element from OUTSIDE bridge's try block.
    import charter.grants as grants
    monkeypatch.setattr(main, "identify", lambda req: None)
    monkeypatch.setattr(auth, "actor_email", lambda req: "jason@example.com")
    monkeypatch.setattr(main, "actor_email", lambda req: "jason@example.com")
    monkeypatch.setattr(grants, "_fetch",
                        lambda: {"jason@example.com": {"allow": [["*"]]}})
    grants.reload()
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "sync.status"})))
    assert status == 401
    assert body["error"] == "unauthorized"
