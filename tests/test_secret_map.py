"""The cached Secret Manager loader shared by both identification maps.

The hardening (payload-shape validation, a fail-closed env fallback) was
written on the grants map only. These pin it on the key map, where a malformed
CHARTER_KEYS or a wrong-shaped payload used to raise straight out of identify()
into bridge() at cold start -- outside its try block, so a bare 500.
"""
import charter.auth as auth
from charter import grants, secret_map
from charter import settings as settings_mod


class _Req:
    def __init__(self, headers):
        self.headers = headers


def _fetch_down(monkeypatch):
    def boom():
        raise RuntimeError("secret manager down")
    monkeypatch.setattr(auth._MAP, "_fetch", boom)


def test_malformed_charter_keys_cold_start_yields_no_caller(monkeypatch):
    monkeypatch.setenv("CHARTER_KEYS", "{not valid json")
    settings_mod.get_settings.cache_clear()
    _fetch_down(monkeypatch)
    assert auth.identify(_Req({"X-API-Key": "anything"})) is None


def test_non_object_charter_keys_cold_start_yields_no_caller(monkeypatch):
    monkeypatch.setenv("CHARTER_KEYS", '["sha256:abc"]')
    settings_mod.get_settings.cache_clear()
    _fetch_down(monkeypatch)
    assert auth.identify(_Req({"X-API-Key": "anything"})) is None


def test_top_level_array_keys_payload_yields_no_caller(monkeypatch):
    # Secret Manager returning a top-level JSON array (wrong shape) is treated
    # like a fetch failure, not handed on as a map to .get().
    monkeypatch.setenv("CHARTER_KEYS", "{}")
    settings_mod.get_settings.cache_clear()
    monkeypatch.setattr(auth._MAP, "_fetch", lambda: ["sha256:abc"])
    assert auth.identify(_Req({"X-API-Key": "anything"})) is None


def _cloudflare_env(monkeypatch):
    monkeypatch.setenv("CHARTER_BACKEND", "cloudflare")
    monkeypatch.setenv("CF_ACCOUNT_ID", "a")
    monkeypatch.setenv("CF_D1_DATABASE_ID", "d")
    monkeypatch.setenv("CF_API_TOKEN", "t")
    settings_mod.get_settings.cache_clear()


def test_cloudflare_backend_reads_keys_from_env_without_secret_manager(monkeypatch):
    _cloudflare_env(monkeypatch)
    monkeypatch.setenv("CHARTER_KEYS", '{"sha256:abc": {"name": "k", "interface": "api", "allow": ["verbs.list"]}}')
    calls = []
    monkeypatch.setattr(secret_map, "_sm_client", lambda: calls.append(1))
    auth._MAP.reset()
    assert "sha256:abc" in auth._MAP.get()
    auth._MAP.reload()
    assert "sha256:abc" in auth._MAP.get()
    assert calls == []            # Secret Manager never touched, even on reload


def test_cloudflare_backend_reads_grants_from_env(monkeypatch):
    _cloudflare_env(monkeypatch)
    monkeypatch.setenv("CHARTER_GRANTS", '{"a@example.com": {"allow": ["verbs.list"]}}')
    calls = []
    monkeypatch.setattr(secret_map, "_sm_client", lambda: calls.append(1))
    grants._MAP.reset()
    assert grants.grants_for("a@example.com") == ["verbs.list"]
    assert calls == []
