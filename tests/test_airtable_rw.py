"""Generic Airtable client: pagination, batching, auth seam."""
import pytest

from charter.packs.airtable import airtable_rw as rw


@pytest.fixture(autouse=True)
def _pack_env(monkeypatch):
    monkeypatch.setenv("AIRTABLE_BASE_ID", "appTestBase")
    monkeypatch.setenv("PERSONAL_ACCESS_TOKEN", "pat")


class FakeResp:
    def __init__(self, payload):
        self._p = payload
        self.status_code = 200

    def json(self):
        return self._p

    def raise_for_status(self):
        pass


def test_get_record_returns_fields(monkeypatch):
    def fake_get(url, **kw):
        assert url.endswith("/tblT/recA")
        assert kw["params"]["returnFieldsByFieldId"] == "true"
        return FakeResp({"id": "recA", "fields": {"fldX": 1}})
    monkeypatch.setattr(rw.requests, "get", fake_get)
    assert rw.get_record("tblT", "recA") == {"fldX": 1}


def test_list_records_follows_pagination(monkeypatch):
    pages = [
        {"records": [{"id": "rec1", "fields": {}}], "offset": "next"},
        {"records": [{"id": "rec2", "fields": {}}]},
    ]
    seen_params = []

    def fake_get(url, **kw):
        seen_params.append(dict(kw["params"]))
        return FakeResp(pages.pop(0))
    monkeypatch.setattr(rw.requests, "get", fake_get)

    records = rw.list_records("tblT", "{Status}='Pending'")
    assert [r["id"] for r in records] == ["rec1", "rec2"]
    assert seen_params[0]["filterByFormula"] == "{Status}='Pending'"
    assert "offset" not in seen_params[0]
    assert seen_params[1]["offset"] == "next"


def test_patch_records_batches_of_ten(monkeypatch):
    calls = []
    monkeypatch.setattr(rw.requests, "patch",
                        lambda url, **kw: calls.append((url, kw["json"])) or FakeResp({}))
    rw.patch_records("tblT", [{"id": f"rec{i}", "fields": {"fldX": 1}} for i in range(23)])
    assert [len(payload["records"]) for _, payload in calls] == [10, 10, 3]
    assert all(url.endswith("/tblT") for url, _ in calls)


def test_headers_require_token(monkeypatch):
    monkeypatch.setenv("PERSONAL_ACCESS_TOKEN", "")
    with pytest.raises(KeyError):
        rw._headers()
