"""gdrive reference pack: resumable-session initiation, the §4.5 client-upload path."""
import pytest

from charter.errors import VerbError
from charter.packs.gdrive import gdrive_upload as up
from charter.sdk import is_read


@pytest.fixture(autouse=True)
def _token(monkeypatch):
    monkeypatch.setattr(up, "_token", lambda: "tok")


class FakeResp:
    def __init__(self, status_code=200, headers=None, text=""):
        self.status_code = status_code
        self.headers = headers or {}
        self.text = text


def test_initiate_upload_returns_session_uri(monkeypatch):
    seen = {}

    def fake_post(url, **kw):
        seen.update(kw, url=url)
        return FakeResp(headers={"Location": "https://upload.example/session-1"})
    monkeypatch.setattr(up.requests, "post", fake_post)

    r = up.initiate_upload({"filename": "hero.png", "folder_id": "F" * 20,
                            "mime_type": "image/png"}, caller={})
    assert r["upload_uri"] == "https://upload.example/session-1"
    assert r["target"] == f"google_folder:{'F' * 20}"
    assert "PUT" in r["next"]                      # client-side instruction travels with the URI
    assert seen["url"] == up.UPLOAD_URL
    assert seen["params"] == {"uploadType": "resumable", "supportsAllDrives": "true"}
    assert seen["json"] == {"name": "hero.png", "parents": ["F" * 20]}
    assert seen["headers"]["Authorization"] == "Bearer tok"
    assert seen["headers"]["X-Upload-Content-Type"] == "image/png"


@pytest.mark.parametrize("body", [{}, {"filename": "a.png"}, {"folder_id": "F" * 20}])
def test_initiate_upload_requires_filename_and_folder(body):
    with pytest.raises(VerbError) as e:
        up.initiate_upload(body, caller={})
    assert e.value.status == 400


def test_initiate_upload_maps_upstream_failure(monkeypatch):
    monkeypatch.setattr(up.requests, "post",
                        lambda url, **kw: FakeResp(status_code=403, text="denied"))
    with pytest.raises(VerbError) as e:
        up.initiate_upload({"filename": "a.png", "folder_id": "F" * 20}, caller={})
    assert e.value.status == 502


def test_initiate_upload_rejects_missing_location(monkeypatch):
    monkeypatch.setattr(up.requests, "post", lambda url, **kw: FakeResp())
    with pytest.raises(VerbError) as e:
        up.initiate_upload({"filename": "a.png", "folder_id": "F" * 20}, caller={})
    assert e.value.status == 502


def test_verb_registers_as_write():
    import charter.packs.gdrive  # noqa: F401  (self-registers on import)
    assert not is_read("gdrive.file.initiate_upload")
