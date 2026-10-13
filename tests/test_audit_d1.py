import logging
import re
from pathlib import Path

import pytest
import requests

from charter import audit, settings


@pytest.fixture
def cf(monkeypatch):
    monkeypatch.setenv("CHARTER_BACKEND", "cloudflare")
    monkeypatch.setenv("CF_ACCOUNT_ID", "acct1")
    monkeypatch.setenv("CF_D1_DATABASE_ID", "db1")
    monkeypatch.setenv("CF_API_TOKEN", "tok1")
    settings.get_settings.cache_clear()


class _Resp:
    def __init__(self, status, body, content=b"x"):
        self.status_code, self._b, self.content = status, body, content

    @property
    def ok(self):
        return self.status_code < 400

    def json(self):
        if isinstance(self._b, Exception):
            raise self._b
        return self._b


def test_d1_insert_shape(cf, monkeypatch):
    calls = []

    def post(url, headers=None, json=None, timeout=None):
        calls.append((url, headers, json))
        return _Resp(200, {"success": True, "result": []})

    monkeypatch.setattr(audit.requests, "post", post)
    audit.record({"name": "k", "interface": "api"}, "verbs.list", None, "ok", rid="r1")
    url, headers, body = calls[0]
    assert url == "https://api.cloudflare.com/client/v4/accounts/acct1/d1/database/db1/query"
    assert headers["Authorization"] == "Bearer tok1"
    assert body["sql"].startswith("INSERT INTO audit (")
    cols = body["sql"].split("(")[1].split(")")[0].split(", ")
    assert "target" not in cols                      # None values are omitted -> NULL
    assert body["params"][cols.index("verb")] == "verbs.list"
    assert body["params"][cols.index("actor")] == "k"


def test_d1_failure_respects_fail_open(cf, monkeypatch):
    monkeypatch.setattr(audit.requests, "post",
                        lambda *a, **k: _Resp(500, {"success": False, "errors": [{"message": "x"}]}))
    audit.record(None, "v", None, "ok", rid="r")                      # fail_open: no raise
    with pytest.raises(RuntimeError):
        audit.record(None, "v", None, "attempt", rid="r", fail_open=False)


def test_d1_non_json_error_body_still_raises_runtime_error(cf, monkeypatch):
    monkeypatch.setattr(audit.requests, "post", lambda *a, **k: _Resp(502, ValueError("not json"), b"<html>"))
    with pytest.raises(RuntimeError) as e:
        audit.record(None, "v", None, "attempt", rid="r", fail_open=False)
    assert "502" in str(e.value) and "tok1" not in str(e.value)


@pytest.mark.parametrize("exc", [requests.ConnectionError("down"), requests.Timeout("slow")])
def test_d1_transport_errors_follow_fail_open(cf, monkeypatch, caplog, exc):
    def boom(*a, **k):
        raise exc

    monkeypatch.setattr(audit.requests, "post", boom)
    with caplog.at_level(logging.ERROR):
        audit.record(None, "v", None, "ok", rid="r")                  # fail_open: swallowed
    assert "tok1" not in caplog.text
    with pytest.raises(type(exc)):
        audit.record(None, "v", None, "attempt", rid="r", fail_open=False)


def test_d1_schema_matches_row_columns(cf, monkeypatch):
    calls = []
    monkeypatch.setattr(audit.requests, "post",
                        lambda url, headers=None, json=None, timeout=None:
                        calls.append(json) or _Resp(200, {"success": True}))
    audit.begin_trace("00-" + "a" * 32 + "-" + "b" * 16 + "-01")
    try:
        audit.record({"name": "k", "interface": "api"}, "v", "t", "ok", rid="r",
                     detail="d", on_behalf_of="u", credential="app")
    finally:
        audit.begin_trace(None)
    sent = set(calls[0]["sql"].split("(")[1].split(")")[0].split(", "))
    ddl = (Path(__file__).parent.parent / "sql" / "audit_table.d1.sql").read_text()
    table = ddl.split("CREATE TABLE")[1].split(");")[0]
    declared = set(re.findall(r"\b([a-z_]+) TEXT", table))
    assert sent == declared
