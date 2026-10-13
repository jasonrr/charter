"""smoke pack: the live-deploy probe verb, loaded only when PACKS names its module path."""
import json
import sys

import pytest

import charter.main as main
from charter.sdk import VERBS, PREFIXES, _DECLARED_READ, _DRY_RUN, loader

PACK = "charter.packs.smoke"


@pytest.fixture(autouse=True)
def _preserve_sdk_state():
    """load_packs mutates process-global registries; restore them afterwards."""
    saved = (dict(VERBS), dict(PREFIXES), dict(_DECLARED_READ), set(_DRY_RUN),
             list(loader._LOADED_PACKS))
    sys.modules.pop(PACK, None)
    yield
    sys.modules.pop(PACK, None)
    VERBS.clear()
    VERBS.update(saved[0])
    PREFIXES.clear()
    PREFIXES.update(saved[1])
    _DECLARED_READ.clear()
    _DECLARED_READ.update(saved[2])
    _DRY_RUN.clear()
    _DRY_RUN.update(saved[3])
    loader._LOADED_PACKS[:] = saved[4]


class FakeRequest:
    def __init__(self, body):
        self.headers = {}
        self._body = body

    def get_json(self, silent=False):
        return self._body


def _bridge(monkeypatch, body):
    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "t", "interface": "test",
                                     "allow": ["*"], "require_actor": False})
    monkeypatch.setattr(main, "allowed", lambda caller, verb: True)
    monkeypatch.setattr(main, "record", lambda *a, **k: None)
    resp, status, _headers = main.bridge(FakeRequest(body))
    return json.loads(resp), status


@pytest.fixture
def smoke_loaded(monkeypatch):
    monkeypatch.setenv("PACKS", PACK)
    main.get_settings.cache_clear()
    try:
        loader.load_packs(main.get_settings())
    finally:
        main.get_settings.cache_clear()


def test_sleep_returns_seconds_slept(monkeypatch, smoke_loaded):
    body, status = _bridge(monkeypatch, {"verb": "smoke.sleep", "seconds": 0})
    assert status == 200 and body["slept"] == 0


@pytest.mark.parametrize("seconds", [601, -1, "3", 1.5, True, None])
def test_sleep_rejects_out_of_range_or_non_int(monkeypatch, smoke_loaded, seconds):
    body, status = _bridge(monkeypatch, {"verb": "smoke.sleep", "seconds": seconds})
    assert status == 400 and body["ok"] is False


def test_smoke_is_inert_under_the_default_packs(monkeypatch):
    monkeypatch.delenv("PACKS", raising=False)
    main.get_settings.cache_clear()
    try:
        loader.load_packs(main.get_settings())
    finally:
        main.get_settings.cache_clear()
    assert "smoke.sleep" not in VERBS
