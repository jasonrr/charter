"""result.read: producer-only dereference of offloaded results, always-allowed."""
import json

from charter import main, results


class FakeRequest:
    def __init__(self, body):
        self.headers = {}
        self._body = body

    def get_json(self, silent=False):
        return self._body


def _parse(resp):
    body, status, _headers = resp
    return json.loads(body), status


CALLER = {"name": "key-a", "interface": "api", "allow": [], "require_actor": False}


def _wire(monkeypatch, rows):
    monkeypatch.setattr(main, "identify", lambda req: dict(CALLER))
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    monkeypatch.setattr(main, "record", lambda *a, **k: rows.append((a, k)))


def test_result_read_returns_owned_blob_despite_empty_allow(monkeypatch):
    rows = []
    _wire(monkeypatch, rows)
    seen = {}

    def fake_fetch(rid, producer):
        seen["rid"], seen["producer"] = rid, producer
        return '{"ok": true, "big": 1}'

    monkeypatch.setattr(results, "fetch", fake_fetch)
    body, status = _parse(main.bridge(FakeRequest({"verb": "result.read", "id": "A" * 24})))
    assert status == 200
    assert body["content"] == '{"ok": true, "big": 1}'
    assert body["mime"] == "application/json"
    # the producer passed through is the caller record's name — that IS the authz
    assert seen == {"rid": "A" * 24, "producer": "key-a"}
    # audited as a normal ok row with the result target
    assert any(a[3] == "ok" and a[2] == f"result:{'A' * 24}" for a, k in rows)


def test_result_read_maps_result_unknown(monkeypatch):
    rows = []
    _wire(monkeypatch, rows)
    from charter.errors import VerbError

    def deny(rid, producer):
        raise VerbError(404, "result_unknown")

    monkeypatch.setattr(results, "fetch", deny)
    body, status = _parse(main.bridge(FakeRequest({"verb": "result.read", "id": "B" * 24})))
    assert status == 404
    assert body["error"] == "result_unknown"
    assert any(a[3] == "result_unknown" for a, k in rows)


def test_result_read_is_listed_and_read(monkeypatch):
    # always-allowed: empty allow-list still passes _can; classified as a read verb
    assert main._can(dict(CALLER), "result.read")
    assert main._is_read("result.read")
