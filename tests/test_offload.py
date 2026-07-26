"""bridge() auto-offload (§4.5): oversize success envelopes move to the results
store; the caller gets a small result_ref envelope instead."""
import json

from charter import main, results
from charter import settings as settings_mod


class FakeRequest:
    def __init__(self, body):
        self.headers = {}
        self._body = body

    def get_json(self, silent=False):
        return self._body


def _parse(resp):
    body, status, _headers = resp
    return json.loads(body), status


CALLER = {"name": "key-a", "interface": "api", "allow": ["*"], "require_actor": False}


def _wire(monkeypatch, *, bucket="test-bucket", threshold="100"):
    monkeypatch.setattr(main, "identify", lambda req: dict(CALLER))
    monkeypatch.setattr(main, "allowed", lambda caller, verb: True)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    monkeypatch.setattr(main, "record", lambda *a, **k: None)
    monkeypatch.setenv("RESULTS_BUCKET", bucket)
    monkeypatch.setenv("MAX_INLINE_BYTES", threshold)
    settings_mod.get_settings.cache_clear()


def test_oversize_success_offloads(monkeypatch):
    _wire(monkeypatch)
    stored = {}

    def fake_store(body_json, producer, verb):
        stored.update(body=body_json, producer=producer, verb=verb)
        return "R" * 32

    monkeypatch.setattr(results, "store", fake_store)
    monkeypatch.setitem(main.VERBS, "test.big", (lambda b, c: {"blob": "x" * 500}, "post"))
    body, status = _parse(main.bridge(FakeRequest({"verb": "test.big"})))
    assert status == 200
    assert body["ok"] is True and body["verb"] == "test.big"
    assert body["result_ref"]["id"] == "R" * 32
    assert body["result_ref"]["mime"] == "application/json"
    assert "blob" not in body                      # the payload moved out
    # the stored envelope is the FULL success envelope, and bytes matches it
    full = json.loads(stored["body"])
    assert full["blob"] == "x" * 500 and full["ok"] is True
    assert body["result_ref"]["bytes"] == len(stored["body"].encode())
    assert (stored["producer"], stored["verb"]) == ("api:key-a", "test.big")


def test_small_success_stays_inline(monkeypatch):
    _wire(monkeypatch, threshold="1000000")
    monkeypatch.setattr(results, "store", lambda *a: (_ for _ in ()).throw(AssertionError("must not store")))
    monkeypatch.setitem(main.VERBS, "test.small", (lambda b, c: {"blob": "x"}, "post"))
    body, status = _parse(main.bridge(FakeRequest({"verb": "test.small"})))
    assert status == 200 and body["blob"] == "x" and "result_ref" not in body


def test_no_bucket_disables_offload(monkeypatch):
    _wire(monkeypatch, bucket="", threshold="100")
    monkeypatch.setattr(results, "store", lambda *a: (_ for _ in ()).throw(AssertionError("must not store")))
    monkeypatch.setitem(main.VERBS, "test.big", (lambda b, c: {"blob": "x" * 500}, "post"))
    body, status = _parse(main.bridge(FakeRequest({"verb": "test.big"})))
    assert status == 200 and body["blob"] == "x" * 500


def test_result_read_is_never_reoffloaded(monkeypatch):
    _wire(monkeypatch, threshold="100")
    monkeypatch.setattr(results, "store", lambda *a: (_ for _ in ()).throw(AssertionError("must not store")))
    monkeypatch.setattr(results, "fetch", lambda rid, producer: "y" * 500)
    body, status = _parse(main.bridge(FakeRequest({"verb": "result.read", "id": "A" * 24})))
    assert status == 200 and body["content"] == "y" * 500


def test_offload_failure_falls_open_to_inline(monkeypatch):
    _wire(monkeypatch, threshold="100")

    def broken_store(*a):
        raise RuntimeError("bucket down")

    monkeypatch.setattr(results, "store", broken_store)
    monkeypatch.setitem(main.VERBS, "test.big", (lambda b, c: {"blob": "x" * 500}, "post"))
    body, status = _parse(main.bridge(FakeRequest({"verb": "test.big"})))
    assert status == 200 and body["blob"] == "x" * 500   # verb succeeded; inline fallback
