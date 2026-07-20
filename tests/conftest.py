import os

import pytest

# Engine config env for the whole suite, set before any test module imports main
# (which validates settings at import).
os.environ.setdefault("GCP_PROJECT", "charter-fixture")
os.environ.setdefault("GOOGLE_OAUTH_CLIENT_ID", "test-client-id.apps.googleusercontent.com")
os.environ.setdefault("ALLOWED_DOMAIN", "@example.com")

from charter import identity_context
from charter import settings as settings_mod


@pytest.fixture(autouse=True)
def _reset_identity_context():
    # pytest runs tests on one reused thread; contextvars persist across tests
    # without this. Reset to the "outside a request / machine caller" state.
    identity_context.begin(None, False)
    yield


@pytest.fixture(autouse=True)
def _reset_settings_cache():
    # get_settings() is process-cached; clear around each test so
    # monkeypatch.setenv is always picked up (and never leaks across tests).
    settings_mod.get_settings.cache_clear()
    yield
    settings_mod.get_settings.cache_clear()
