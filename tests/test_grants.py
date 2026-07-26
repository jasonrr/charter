import json

import pytest

import charter.grants as grants
from charter import settings as settings_mod


def _seed(monkeypatch, mapping):
    # Bypass Secret Manager: stub the fetch and force a reload.
    monkeypatch.setattr(grants._MAP, "_fetch", lambda: mapping)
    grants.reload()


def test_granted_email_gets_allow(monkeypatch):
    _seed(monkeypatch, {"jason@example.com": {"allow": ["data.*", "content.*.draft*"]}})
    assert grants.grants_for("jason@example.com") == ["data.*", "content.*.draft*"]


def test_ungranted_email_gets_none(monkeypatch):
    _seed(monkeypatch, {"jason@example.com": {"allow": ["data.*"]}})
    assert grants.grants_for("nobody@example.com") is None


def test_fetch_error_cold_start_uses_env_fallback(monkeypatch):
    # The cold-start branch (no map cached yet) is reachable because conftest's
    # autouse _reset_secret_maps clears it before every test.
    monkeypatch.setenv("CHARTER_GRANTS",
                       json.dumps({"sam@example.com": {"allow": ["*"]}}))
    settings_mod.get_settings.cache_clear()

    def boom():
        raise RuntimeError("secret manager down")

    monkeypatch.setattr(grants._MAP, "_fetch", boom)
    grants.reload()
    assert grants.grants_for("sam@example.com") == ["*"]


def test_fetch_error_keeps_last_good(monkeypatch):
    _seed(monkeypatch, {"jason@example.com": {"allow": ["data.*"]}})
    assert grants.grants_for("jason@example.com") == ["data.*"]

    def boom():
        raise RuntimeError("transient blip")

    monkeypatch.setattr(grants._MAP, "_fetch", boom)
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
    rec, email = auth.identify_by_actor(_Req({"X-Actor-Token": "t"}))
    assert rec == {"name": "jason@example.com", "interface": "oauth",
                   "allow": ["data.*"], "require_actor": False}
    assert email == "jason@example.com"


def test_identify_by_actor_no_token(monkeypatch):
    monkeypatch.setattr(auth, "actor_email", lambda req: None)
    assert auth.identify_by_actor(_Req({})) == (None, None)


def test_identify_by_actor_invalid_token_raises(monkeypatch):
    # The reason must survive: swallowing it into None is what left forged,
    # replayed and expired tokens unaudited on the keyless path.
    def bad(req):
        raise VerbError(401, "actor_invalid", "rejected")
    monkeypatch.setattr(auth, "actor_email", bad)
    with pytest.raises(VerbError) as e:
        auth.identify_by_actor(_Req({"X-Actor-Token": "bad"}))
    assert e.value.code == "actor_invalid"


def test_identify_by_actor_no_grant_keeps_the_verified_email(monkeypatch):
    # No caller, but the email is verified -- the dispatcher audits it.
    monkeypatch.setattr(auth, "actor_email", lambda req: "nobody@example.com")
    monkeypatch.setattr(auth, "grants_for", lambda email: None)
    assert auth.identify_by_actor(_Req({"X-Actor-Token": "t"})) == (
        None, "nobody@example.com")


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


def test_allow_with_non_string_element_fails_closed(monkeypatch):
    # `[["*"]]` is a plausible hand-edit typo for `["*"]`. Every element must be
    # a string: auth.allowed calls .endswith on each one.
    _seed(monkeypatch, {"jason@example.com": {"allow": [["*"]]}})
    assert grants.grants_for("jason@example.com") is None


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
    monkeypatch.setenv("CHARTER_GRANTS", "{}")
    settings_mod.get_settings.cache_clear()
    monkeypatch.setattr(grants._MAP, "_fetch", lambda: ["jason@example.com"])
    grants.reload()
    assert grants.grants_for("jason@example.com") is None


def test_malformed_charter_grants_cold_start_yields_no_scope(monkeypatch):
    # Cold-start fallback: malformed JSON in CHARTER_GRANTS must not raise;
    # it must fail closed to no scope.
    monkeypatch.setenv("CHARTER_GRANTS", "{not valid json")
    settings_mod.get_settings.cache_clear()

    def boom():
        raise RuntimeError("secret manager down")

    monkeypatch.setattr(grants._MAP, "_fetch", boom)
    grants.reload()
    assert grants.grants_for("jason@example.com") is None


# --- shared allow-list hardening (both identification paths) ------------------

def test_non_string_allow_element_denied_via_auth_allowed():
    # Belt-and-suspenders for the key path, whose records come from a
    # separately hand-edited secret: allowed() must deny, not raise
    # AttributeError out of the dispatcher (an unaudited bare 500).
    for bad in ([["*"]], [1], [None], [{"*": True}]):
        caller = {"name": "cron", "interface": "cron", "allow": bad}
        assert auth.allowed(caller, "admin.reload_keys") is False


def test_grants_for_returns_a_copy(monkeypatch):
    # The caller record is handed to every verb handler; a handler appending to
    # it must not widen the process-wide cached grants map.
    _seed(monkeypatch, {"jason@example.com": {"allow": ["data.*"]}})
    allow = grants.grants_for("jason@example.com")
    allow.append("*")
    assert grants.grants_for("jason@example.com") == ["data.*"]


def test_identify_returns_a_copy_of_the_key_allow_list(monkeypatch):
    import hashlib
    digest = "sha256:" + hashlib.sha256(b"k").hexdigest()
    cached = {digest: {"name": "cron", "interface": "cron", "allow": ["sync.*"]}}
    monkeypatch.setattr(auth, "_keys", lambda: cached)
    rec = auth.identify(_Req({"X-API-Key": "k"}))
    rec["allow"].append("*")
    assert auth.identify(_Req({"X-API-Key": "k"}))["allow"] == ["sync.*"]


def _identify_with_key_record(monkeypatch, rec):
    import hashlib
    digest = "sha256:" + hashlib.sha256(b"k").hexdigest()
    monkeypatch.setattr(auth, "_keys", lambda: {digest: rec})
    return auth.identify(_Req({"X-API-Key": "k"}))


# R2: grants_for validated the record shape; identify() did raw rec["allow"] /
# rec["name"] on a separately hand-edited secret. Every shape below used to
# raise KeyError or TypeError out of identify() at main.py's `caller =
# identify(request)` -- outside bridge()'s try block, so a bare 500 with no
# audit row and no request_id, on every request bearing that key. Both paths
# now share secret_map.allow_list.
@pytest.mark.parametrize("rec", [
    {"name": "cron", "interface": "cron"},              # `allow` missing
    ["*"],                                              # entry is a list
    "data.*",                                           # entry is a string
    {"name": "cron", "allow": "data.*"},                # allow is a string
    {"name": "cron", "allow": [["*"]]},                 # allow has a non-string
    {"interface": "cron", "allow": ["sync.*"]},         # `name` missing
])
def test_identify_fails_closed_on_a_malformed_key_record(monkeypatch, rec):
    assert _identify_with_key_record(monkeypatch, rec) is None


def test_identify_still_accepts_a_well_formed_record(monkeypatch):
    assert _identify_with_key_record(
        monkeypatch, {"name": "cron", "interface": "cron", "allow": ["sync.*"]}
    ) == {"name": "cron", "interface": "cron", "allow": ["sync.*"],
          "require_actor": False}
