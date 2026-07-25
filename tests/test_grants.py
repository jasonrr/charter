import json

import charter.grants as grants
from charter import settings as settings_mod


def _seed(monkeypatch, mapping):
    # Bypass Secret Manager: stub the fetch and force a reload.
    monkeypatch.setattr(grants, "_fetch", lambda: mapping)
    grants.reload()


def test_granted_email_gets_allow(monkeypatch):
    _seed(monkeypatch, {"jason@example.com": {"allow": ["data.*", "content.*.draft*"]}})
    assert grants.grants_for("jason@example.com") == ["data.*", "content.*.draft*"]


def test_ungranted_email_gets_none(monkeypatch):
    _seed(monkeypatch, {"jason@example.com": {"allow": ["data.*"]}})
    assert grants.grants_for("nobody@example.com") is None


def test_fetch_error_cold_start_uses_env_fallback(monkeypatch):
    # _GRANTS persists across tests; reset it so the cold-start branch
    # (_GRANTS is None) is actually reached here instead of short-circuiting
    # to the last-good map left behind by an earlier test.
    monkeypatch.setattr(grants, "_GRANTS", None)

    monkeypatch.setenv("CHARTER_GRANTS",
                       json.dumps({"sam@example.com": {"allow": ["*"]}}))
    settings_mod.get_settings.cache_clear()

    def boom():
        raise RuntimeError("secret manager down")

    monkeypatch.setattr(grants, "_fetch", boom)
    grants.reload()
    assert grants.grants_for("sam@example.com") == ["*"]


def test_fetch_error_keeps_last_good(monkeypatch):
    _seed(monkeypatch, {"jason@example.com": {"allow": ["data.*"]}})
    assert grants.grants_for("jason@example.com") == ["data.*"]

    def boom():
        raise RuntimeError("transient blip")

    monkeypatch.setattr(grants, "_fetch", boom)
    grants.reload()  # forces re-fetch; fetch fails, last-good map must survive
    assert grants.grants_for("jason@example.com") == ["data.*"]


import charter.auth as auth
from charter.errors import VerbError


class _Req:
    def __init__(self, headers):
        self.headers = headers


def test_identify_by_actor_granted_email(monkeypatch):
    monkeypatch.setattr(auth, "actor_email", lambda req: "jason@example.com")
    monkeypatch.setattr(auth, "grants_for", lambda email: ["data.*"])
    rec = auth.identify_by_actor(_Req({"X-Actor-Token": "t"}))
    assert rec == {"name": "jason@example.com", "interface": "oauth",
                   "allow": ["data.*"], "require_actor": False}


def test_identify_by_actor_no_token(monkeypatch):
    monkeypatch.setattr(auth, "actor_email", lambda req: None)
    assert auth.identify_by_actor(_Req({})) is None


def test_identify_by_actor_invalid_token(monkeypatch):
    def bad(req):
        raise VerbError(401, "actor_invalid", "rejected")
    monkeypatch.setattr(auth, "actor_email", bad)
    assert auth.identify_by_actor(_Req({"X-Actor-Token": "bad"})) is None


def test_identify_by_actor_no_grant(monkeypatch):
    monkeypatch.setattr(auth, "actor_email", lambda req: "nobody@example.com")
    monkeypatch.setattr(auth, "grants_for", lambda email: None)
    assert auth.identify_by_actor(_Req({"X-Actor-Token": "t"})) is None


# --- malformed-secret guards: fail closed, never raise ------------------------

def test_allow_as_string_fails_closed(monkeypatch):
    # A JSON string (not a list) for `allow` must not escalate to full scope:
    # iterating a string yields characters, and a "*" character would match
    # every verb via fnmatch if it reached auth.allowed unchecked.
    _seed(monkeypatch, {"jason@example.com": {"allow": "data.*"}})
    assert grants.grants_for("jason@example.com") is None


def test_allow_as_string_denied_via_auth_allowed():
    # Belt-and-suspenders: even if a caller record somehow carried a string
    # allow, auth.allowed itself must deny rather than match per-character.
    caller = {"name": "jason@example.com", "interface": "oauth", "allow": "data.*"}
    assert auth.allowed(caller, "admin.reload_keys") is False


def test_entry_as_list_yields_none(monkeypatch):
    _seed(monkeypatch, {"jason@example.com": ["data.*"]})
    assert grants.grants_for("jason@example.com") is None


def test_entry_as_string_yields_none(monkeypatch):
    _seed(monkeypatch, {"jason@example.com": "data.*"})
    assert grants.grants_for("jason@example.com") is None


def test_top_level_array_from_secret_yields_no_scope(monkeypatch):
    # Secret Manager returning a top-level JSON array (wrong shape) must not
    # raise (an AttributeError from treating a list like a dict); it's treated
    # like a fetch failure and yields no scope.
    monkeypatch.setattr(grants, "_GRANTS", None)
    monkeypatch.setenv("CHARTER_GRANTS", "{}")
    settings_mod.get_settings.cache_clear()
    monkeypatch.setattr(grants, "_fetch", lambda: ["jason@example.com"])
    grants.reload()
    assert grants.grants_for("jason@example.com") is None


def test_malformed_charter_grants_cold_start_yields_no_scope(monkeypatch):
    # Cold-start fallback: malformed JSON in CHARTER_GRANTS must not raise;
    # it must fail closed to no scope.
    monkeypatch.setattr(grants, "_GRANTS", None)
    monkeypatch.setenv("CHARTER_GRANTS", "{not valid json")
    settings_mod.get_settings.cache_clear()

    def boom():
        raise RuntimeError("secret manager down")

    monkeypatch.setattr(grants, "_fetch", boom)
    grants.reload()
    assert grants.grants_for("jason@example.com") is None
