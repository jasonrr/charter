"""U2: pack SDK primitives + loader, and the engine/pack split of main.py.

Characterization anchors: the full existing suite (test_bridge.py et al.) must
pass unchanged, and verbs.list output for a seeded caller must be byte-identical
to the pre-split snapshot (fixtures/verbs_list_*.json, captured from HEAD~).
"""
import json
import logging
import pathlib
import sys
import types

import pytest

import charter.main as main
from charter.sdk import (VERBS, PREFIXES, PackError, register, register_prefix,
                         _DECLARED_READ, _DRY_RUN)
from charter.sdk import loader

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
PACKS_DIR = pathlib.Path(__file__).parent / "fixture_packs"
FIXTURE_MODS = ("good_pack", "bad_pack", "conflict_pack", "collision_pack",
                "config_pack")


@pytest.fixture(autouse=True)
def _preserve_sdk_state():
    """register()/load_packs() mutate process-global registries (main.VERBS is
    sdk.VERBS). Snapshot/restore around each test so loader tests can't leak
    into the characterization tests."""
    saved = (dict(VERBS), dict(PREFIXES), dict(_DECLARED_READ), set(_DRY_RUN),
             list(loader._LOADED_PACKS))
    for m in FIXTURE_MODS:
        sys.modules.pop(m, None)
    yield
    VERBS.clear()
    VERBS.update(saved[0])
    PREFIXES.clear()
    PREFIXES.update(saved[1])
    _DECLARED_READ.clear()
    _DECLARED_READ.update(saved[2])
    _DRY_RUN.clear()
    _DRY_RUN.update(saved[3])
    loader._LOADED_PACKS[:] = saved[4]
    for m in FIXTURE_MODS:
        sys.modules.pop(m, None)


class FakeRequest:
    def __init__(self, headers=None, body=None):
        self.headers = headers or {}
        self._body = body or {}

    def get_json(self, silent=False):
        return self._body


def _parse(resp):
    body, status, _headers = resp
    return json.loads(body), status


def _stub_caller(monkeypatch):
    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "t", "interface": "test",
                                     "allow": ["*"], "require_actor": False})
    monkeypatch.setattr(main, "allowed", lambda caller, verb: True)
    monkeypatch.setattr(main, "record", lambda *a, **k: None)


def _load(monkeypatch, *entries):
    """Run the loader against settings with PACKS=<entries> (CSV, as env)."""
    monkeypatch.setenv("PACKS", ",".join(entries))
    main.get_settings.cache_clear()
    try:
        loader.load_packs(main.get_settings())
    finally:
        main.get_settings.cache_clear()


class _FakeDist:
    def __init__(self, name):
        self.metadata = {"Name": name}


class _FakeEP:
    """Minimal importlib.metadata.EntryPoint stand-in."""
    def __init__(self, name, dist_name, obj=None):
        self.name = name
        self.dist = _FakeDist(dist_name)
        self._obj = obj
        self.loaded = False

    def load(self):
        self.loaded = True
        return self._obj


# --- happy paths -------------------------------------------------------------

def test_settings_packs_registers_exact_verb_and_prefix_family(monkeypatch):
    _stub_caller(monkeypatch)
    _load(monkeypatch, str(PACKS_DIR / "good_pack.py"))
    # exact verb dispatches through the real bridge wrapper
    body, status = _parse(main.bridge(
        FakeRequest(body={"verb": "test.good.echo", "args": {"a": 1}})))
    assert status == 200 and body["ok"] is True
    assert body["echo"] == {"a": 1}
    # prefix family dispatches too
    body, status = _parse(main.bridge(
        FakeRequest(body={"verb": "test.goodpref.anything"})))
    assert status == 200 and body["leaf"] == "anything"


def test_pack_config_validated_and_delivered_via_get_config(monkeypatch):
    _stub_caller(monkeypatch)
    _load(monkeypatch, str(PACKS_DIR / "good_pack.py"))
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "test.good.echo"})))
    assert status == 200
    # the handler read its config through the validated boundary
    assert body["project"] == "charter-fixture"
    # a pack requiring a missing key is refused at boot with a named error
    with pytest.raises(PackError, match="pack_config"):
        _load(monkeypatch, str(PACKS_DIR / "config_pack.py"))


def test_entry_point_pack_loads_only_when_allowlisted(monkeypatch, caplog):
    pack_obj = types.SimpleNamespace(name="ep-pack")
    good_ep = _FakeEP(name="ep", dist_name="good-dist", obj=pack_obj)
    evil_ep = _FakeEP(name="evil", dist_name="evil-dist", obj=pack_obj)
    monkeypatch.setattr(loader.importlib.metadata, "entry_points",
                        lambda group: [good_ep, evil_ep])
    with caplog.at_level(logging.WARNING):
        _load(monkeypatch, "good-dist")     # only good-dist is allow-listed
    assert good_ep.loaded is True
    assert evil_ep.loaded is False                       # ambient execution refused
    assert any("evil-dist" in r.message for r in caplog.records)
    assert ("ep-pack", "entry-point:good-dist") in loader._LOADED_PACKS


# --- refusals ----------------------------------------------------------------

def test_read_flag_conflict_refused(monkeypatch):
    # direct: read=True on a write-leaf verb contradicts the convention
    with pytest.raises(PackError, match="read_flag_conflict"):
        register("test.x.delete", lambda b, c: {}, "post", read=True)
    # and the symmetric direction (read=False on a read-leaf verb)
    with pytest.raises(PackError, match="read_flag_conflict"):
        register("test.x.status", lambda b, c: {}, "post", read=False)
    # via the loader (conflict raised at pack import -> boot failure)
    with pytest.raises(PackError, match="read_flag_conflict"):
        _load(monkeypatch, str(PACKS_DIR / "conflict_pack.py"))


def test_verb_collision_refused(monkeypatch):
    with pytest.raises(PackError, match="verb_collision"):
        register("verbs.list", lambda b, c: {}, "post")   # engine verb
    with pytest.raises(PackError, match="verb_collision"):
        _load(monkeypatch, str(PACKS_DIR / "collision_pack.py"))


def test_protocol_validation_failure_refused_at_boot(monkeypatch):
    with pytest.raises(PackError, match="pack_validation"):
        _load(monkeypatch, str(PACKS_DIR / "bad_pack.py"))


def test_prefix_collision_and_bad_catalog_refused():
    with pytest.raises(PackError, match="prefix_collision"):
        register_prefix("data.warehouse.", lambda b, c: {}, {"read": True,
                                                         "scope": "data.warehouse.query"})
    with pytest.raises(PackError, match="bad_catalog"):
        register_prefix("test.noscope.", lambda b, c: {}, {"read": True})


# --- read_only guard prefers declared flags -----------------------------------

def test_read_only_guard_prefers_declared_flags(monkeypatch):
    _stub_caller(monkeypatch)
    _load(monkeypatch, str(PACKS_DIR / "good_pack.py"))
    # the pack's read prefix family passes the read-only tool guard
    body, status = _parse(main.bridge(FakeRequest(
        body={"verb": "test.goodpref.anything", "read_only": True})))
    assert status == 200
    # its write exact verb is refused even though the caller is scoped
    body, status = _parse(main.bridge(FakeRequest(
        body={"verb": "test.good.echo", "read_only": True})))
    assert status == 403 and body["error"] == "write_in_read_tool"


def test_is_read_prefers_declared_prefix_flag_over_leaf():
    # a non-read leaf under a registered read family still classifies read
    assert main._is_read("data.warehouse.query") is True
    assert main._is_read("content.hs_post.draft") is False
