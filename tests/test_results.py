"""Results store (§4.5 offload): GCS-backed, producer-only, one 404 for
missing-and-not-yours."""
import pytest

from charter import results
from charter.errors import VerbError


class FakeBlob:
    def __init__(self, name):
        self.name = name
        self.metadata = None
        self.data = None
        self.content_type = None

    def upload_from_string(self, data, content_type=None):
        self.data, self.content_type = data, content_type

    def download_as_text(self):
        return self.data


class FakeBucket:
    def __init__(self):
        self.blobs = {}

    def blob(self, name):
        b = FakeBlob(name)
        self.blobs[name] = b
        return b

    def get_blob(self, name):
        return self.blobs.get(name)


@pytest.fixture
def bucket(monkeypatch):
    fake = FakeBucket()
    monkeypatch.setattr(results, "_bucket", lambda: fake)
    return fake


def test_store_then_fetch_roundtrip(bucket):
    rid = results.store('{"ok": true, "rows": []}', "jason@example.com", "data.warehouse.query")
    assert results.fetch(rid, "jason@example.com") == '{"ok": true, "rows": []}'
    blob = bucket.blobs[f"results/{rid}"]
    assert blob.metadata == {"producer": "jason@example.com", "verb": "data.warehouse.query"}
    assert blob.content_type == "application/json"


def test_id_is_unguessable_format(bucket):
    rid = results.store("{}", "a@example.com", "v")
    assert results._ID_RE.fullmatch(rid)
    assert len(rid) >= 32


def test_fetch_by_wrong_producer_is_result_unknown(bucket):
    rid = results.store("{}", "a@example.com", "v")
    with pytest.raises(VerbError) as e:
        results.fetch(rid, "b@example.com")
    assert (e.value.status, e.value.code) == (404, "result_unknown")


def test_fetch_missing_and_malformed_ids_are_result_unknown(bucket):
    # 23 valid-format chars that were never stored; then malformed shapes.
    for bad in ["A" * 23, "", "short", "../escape", "A" * 80, None]:
        with pytest.raises(VerbError) as e:
            results.fetch(bad, "a@example.com")
        assert e.value.code == "result_unknown"
