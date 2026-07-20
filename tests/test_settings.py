"""Proof for the Settings object (U1): typed deploy-time config, fail-fast
validation, SecretStr hygiene, lazy imports, and startup fail-fast in main.

conftest.py injects the required engine env so the characterization suite keeps
its pre-settings runtime values.
"""
import os
import subprocess
import sys

import pytest

from charter.settings import Settings, get_settings


REQUIRED_ENV = ("GCP_PROJECT", "GOOGLE_OAUTH_CLIENT_ID", "ALLOWED_DOMAIN")


def _clear_required(monkeypatch):
    for name in REQUIRED_ENV:
        monkeypatch.delenv(name, raising=False)


def _set_required(monkeypatch, project="test-proj"):
    monkeypatch.setenv("GCP_PROJECT", project)
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", "cid.apps.googleusercontent.com")
    monkeypatch.setenv("ALLOWED_DOMAIN", "@example.com")


# --- validation ---------------------------------------------------------------

def test_missing_required_value_fails_fast_with_named_field(monkeypatch):
    _clear_required(monkeypatch)
    with pytest.raises(Exception) as e:
        Settings(_env_file=None)
    assert "gcp_project" in str(e.value)


def test_each_required_field_is_named(monkeypatch):
    _clear_required(monkeypatch)
    monkeypatch.setenv("GCP_PROJECT", "p")
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", "c")
    # ALLOWED_DOMAIN still missing
    with pytest.raises(Exception) as e:
        Settings(_env_file=None)
    assert "allowed_domain" in str(e.value)


def test_env_values_resolve_identically_to_former_literals(monkeypatch):
    """Former module-top literals now resolve from env with the same runtime value."""
    monkeypatch.setenv("GCP_PROJECT", "charter-fixture")
    s = Settings(_env_file=None)
    assert s.gcp_project == "charter-fixture"
    assert s.keys_secret_name == "charter-keys"
    assert s.google_refresh_secret_name == "charter-google-refresh"
    assert s.audit_table == "charter.audit"
    assert s.warehouse_datasets == ()


def test_secret_name_defaults(monkeypatch):
    _set_required(monkeypatch)
    s = Settings(_env_file=None)
    assert s.keys_secret_name == "charter-keys"
    assert s.google_refresh_secret_name == "charter-google-refresh"


def test_warehouse_datasets_parses_csv_env(monkeypatch):
    _set_required(monkeypatch)
    monkeypatch.setenv("WAREHOUSE_DATASETS", "alpha,beta")
    assert Settings(_env_file=None).warehouse_datasets == ("alpha", "beta")


def test_packs_parses_csv_env(monkeypatch):
    _set_required(monkeypatch)
    monkeypatch.setenv("PACKS", "my.pack,another.pack")
    assert Settings(_env_file=None).packs == ("my.pack", "another.pack")


def test_env_file_loads_in_dev(monkeypatch, tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "GCP_PROJECT=from-dotenv\nGOOGLE_OAUTH_CLIENT_ID=c\nALLOWED_DOMAIN=@d.co\n")
    for name in REQUIRED_ENV:
        monkeypatch.delenv(name, raising=False)
    assert Settings(_env_file=str(env_file)).gcp_project == "from-dotenv"


# --- SecretStr hygiene ---------------------------------------------------------

def test_secret_material_not_in_repr(monkeypatch):
    _set_required(monkeypatch)
    monkeypatch.setenv("CHARTER_KEYS", '{"sha256:abc": {"name": "x", "allow": ["*"]}}')
    monkeypatch.setenv("DROPBOXSIGN_TOKEN", "super-secret-token")
    s = Settings(_env_file=None)
    rendered = repr(s) + str(s)
    assert "super-secret-token" not in rendered
    assert "sha256:abc" not in rendered
    # ...but the value is there when explicitly unwrapped
    assert s.dropboxsign_token.get_secret_value() == "super-secret-token"


def test_env_passthrough_fields_default_empty(monkeypatch):
    _set_required(monkeypatch)
    s = Settings(_env_file=None)
    assert s.charter_keys.get_secret_value() == ""
    assert s.personal_access_token.get_secret_value() == ""
    assert s.posthog_api_key.get_secret_value() == ""
    assert s.test_mode == ""
    assert s.test_mode_email == ""


# --- get_settings caching -------------------------------------------------------

def test_get_settings_is_cached(monkeypatch):
    get_settings.cache_clear()
    assert get_settings() is get_settings()


def test_cache_clear_picks_up_new_env(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("GCP_PROJECT", "after-clear")
    get_settings.cache_clear()
    assert get_settings().gcp_project == "after-clear"


# --- import safety + startup fail-fast -----------------------------------------

_ENGINE_MODULES = [
    "charter.settings", "charter.errors", "charter.identity_context",
    "charter.actor_auth", "charter.auth", "charter.audit", "charter.main",
]


def _scrubbed_env(tmp_path, with_config=True):
    """No ADC reachable (fresh HOME, no GOOGLE_APPLICATION_CREDENTIALS)."""
    env = {"PATH": os.environ.get("PATH", ""),
           "PYTHONPATH": os.path.abspath(
               os.path.join(os.path.dirname(__file__), "..", "src")),
           "HOME": str(tmp_path)}
    if with_config:
        env.update({"GCP_PROJECT": "charter-fixture",
                    "GOOGLE_OAUTH_CLIENT_ID": "cid",
                    "ALLOWED_DOMAIN": "@example.com"})
    return env


@pytest.mark.parametrize("module", _ENGINE_MODULES)
def test_module_imports_without_credentials(module, tmp_path):
    """Importing an engine module never requires ADC or Secret Manager access."""
    proc = subprocess.run(
        [sys.executable, "-c", f"import {module}"],
        env=_scrubbed_env(tmp_path), capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, f"import {module} failed: {proc.stderr[-500:]}"


def test_main_fails_fast_at_startup_without_required_config(tmp_path):
    """Boot with missing config fails at import (startup), not at first request."""
    proc = subprocess.run(
        [sys.executable, "-c", "import charter.main"],
        env=_scrubbed_env(tmp_path, with_config=False),
        capture_output=True, text=True, timeout=60)
    assert proc.returncode != 0
    assert "gcp_project" in proc.stderr


# --- KTD-3: public env-var names contract --------------------------------------

def test_public_env_var_names_pinned(monkeypatch):
    """Every Settings field has a corresponding public env-var name (KTD-3).
    Renaming a field breaks consuming deployments at boot."""
    _set_required(monkeypatch)
    s = Settings(_env_file=None)
    # Required fields
    assert s.gcp_project == "test-proj"
    assert s.google_oauth_client_id == "cid.apps.googleusercontent.com"
    assert s.allowed_domain == "@example.com"
    # Optional fields with defaults
    assert s.keys_secret_name == "charter-keys"
    assert s.google_refresh_secret_name == "charter-google-refresh"
    assert s.audit_table == "charter.audit"
    assert s.warehouse_datasets == ()
    assert s.packs == ("charter",)
    # Secret fields default empty
    assert s.charter_keys.get_secret_value() == ""
    assert s.personal_access_token.get_secret_value() == ""
