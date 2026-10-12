"""charter keys CLI: settings-contract + rotation-overlap tests (code-review fixes)."""
import json

import pytest

from charter.cli import keys


class _FakeSM:
    def __init__(self, payload=b"{}"):
        self.payload = payload
        self.accessed = []
        self.added = []

    def access_secret_version(self, name):
        self.accessed.append(name)
        return type("R", (), {"payload": type("P", (), {"data": self.payload})()})()

    def add_secret_version(self, parent, payload):
        self.added.append((parent, json.loads(payload["data"].decode())))


def _env(monkeypatch, fake):
    monkeypatch.setenv("GCP_PROJECT", "p1")
    monkeypatch.setattr(keys, "_sm_client", lambda: fake)


def test_cli_reads_and_writes_the_configured_secret(monkeypatch):
    _env(monkeypatch, _FakeSM())
    monkeypatch.setenv("KEYS_SECRET_NAME", "custom-keys")
    fake = keys._sm_client()
    keys._fetch_keys()
    assert fake.accessed == ["projects/p1/secrets/custom-keys/versions/latest"]
    keys._store_keys({})
    assert fake.added[0][0] == "projects/p1/secrets/custom-keys"


def test_rotate_keeps_old_digest_for_zero_downtime_handoff(monkeypatch):
    old = {"sha256:old": {"name": "ci", "interface": "api", "allow": ["*"],
                          "require_actor": False}}
    fake = _FakeSM(json.dumps(old).encode())
    _env(monkeypatch, fake)
    keys._rotate("ci")
    stored = fake.added[0][1]
    assert "sha256:old" in stored                      # old key stays live
    new_digests = [d for d in stored if d != "sha256:old"]
    assert len(new_digests) == 1
    assert stored[new_digests[0]]["name"] == "ci"      # metadata carried over


def test_revoke_by_digest_removes_only_that_digest(monkeypatch):
    both = {"sha256:old": {"name": "ci"}, "sha256:new": {"name": "ci"}}
    fake = _FakeSM(json.dumps(both).encode())
    _env(monkeypatch, fake)
    keys._revoke(digest="sha256:old")
    assert fake.added[0][1] == {"sha256:new": {"name": "ci"}}


def test_mint_requires_explicit_allow(capsys):
    with pytest.raises(SystemExit):
        keys.main(["keys", "mint", "--name", "ci"])    # no --allow -> argparse error


def test_cloudflare_mode_uses_keys_file_and_no_settings(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("CHARTER_BACKEND", "cloudflare")
    monkeypatch.setenv("KEYS_FILE", str(tmp_path / "keys.json"))
    for k in ("GCP_PROJECT", "GOOGLE_OAUTH_CLIENT_ID", "ALLOWED_DOMAIN"):
        monkeypatch.delenv(k, raising=False)           # the CLI must not need engine config
    def no_sm(): raise AssertionError("Secret Manager must not be called")
    monkeypatch.setattr(keys, "_sm_client", no_sm)
    keys._add("agent-a", "api", ["verbs.list"])
    stored = json.loads((tmp_path / "keys.json").read_text())
    assert len(stored) == 1 and next(iter(stored)).startswith("sha256:")
    assert stored[next(iter(stored))]["name"] == "agent-a"
    assert (tmp_path / "keys.json").stat().st_mode & 0o777 == 0o600
    assert "wrangler secret put CORE_CHARTER_KEYS" in capsys.readouterr().err
    keys._revoke(name="agent-a")
    assert json.loads((tmp_path / "keys.json").read_text()) == {}
