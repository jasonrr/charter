"""d1.query / get_map: response-shape strictness. A "success" body with no rows
must raise, because secret_map reads "no row" as "serve the env map"."""
import pytest

from charter import d1, settings


@pytest.fixture
def cf(monkeypatch):
    monkeypatch.setenv("CHARTER_BACKEND", "cloudflare")
    for n in ("CF_ACCOUNT_ID", "CF_D1_DATABASE_ID", "CF_API_TOKEN"):
        monkeypatch.setenv(n, "x")
    settings.get_settings.cache_clear()


class _Resp:
    status_code, ok, content = 200, True, b"x"
    def __init__(self, body): self._b = body
    def json(self): return self._b


def _post(body, monkeypatch):
    monkeypatch.setattr(d1.requests, "post", lambda *a, **k: _Resp(body))


@pytest.mark.parametrize("body", [{"success": True, "result": []}, {"success": True},
                                  {"success": True, "result": [{}]}, {"success": True, "result": None}])
def test_success_without_rows_raises(cf, monkeypatch, body):
    _post(body, monkeypatch)
    with pytest.raises(Exception):
        d1.get_map("keys")


def test_no_row_is_none_but_null_row_is_empty(cf, monkeypatch):
    _post({"success": True, "result": [{"results": []}]}, monkeypatch)
    assert d1.get_map("keys") is None
    _post({"success": True, "result": [{"results": [{"value": "null"}]}]}, monkeypatch)
    assert d1.get_map("keys") == {}
    _post({"success": True, "result": [{"results": [{"value": '{"a": 1}'}]}]}, monkeypatch)
    assert d1.get_map("keys") == {"a": 1}
