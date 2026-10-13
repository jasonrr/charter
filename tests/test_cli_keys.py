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


def _d1_env(monkeypatch, store):
    """Cloudflare mode against an in-memory `config` table."""
    monkeypatch.setenv("CHARTER_BACKEND", "cloudflare")
    for n in ("CF_ACCOUNT_ID", "CF_D1_DATABASE_ID", "CF_API_TOKEN"):
        monkeypatch.setenv(n, "x")
    for k in ("GCP_PROJECT", "GOOGLE_OAUTH_CLIENT_ID", "ALLOWED_DOMAIN"):
        monkeypatch.delenv(k, raising=False)           # the CLI must not need engine config
    monkeypatch.setattr(keys, "_sm_client", lambda: (_ for _ in ()).throw(AssertionError("no SM")))
    monkeypatch.setattr(keys.d1, "get_map", lambda name, creds: store.get(name))
    monkeypatch.setattr(keys.d1, "put_map", lambda name, value, creds: store.__setitem__(name, value))


def test_cloudflare_mode_writes_the_d1_row_and_needs_no_settings(monkeypatch, capsys):
    store = {}
    _d1_env(monkeypatch, store)
    keys._add("agent-a", "api", ["verbs.list"])
    stored = store["keys"]
    assert len(stored) == 1 and next(iter(stored)).startswith("sha256:")
    assert stored[next(iter(stored))]["name"] == "agent-a"
    err = capsys.readouterr().err
    assert "starting a new key map" in err and "wrote keys to D1" in err
    keys._add("b", "api", ["*"])
    assert "starting a new key map" not in capsys.readouterr().err
    keys._revoke(name="agent-a")
    assert list(store["keys"].values())[0]["name"] == "b"


@pytest.mark.parametrize("argv", [["rotate", "--name", "x"], ["revoke", "--name", "x"], ["list"]])
def test_cloudflare_mode_missing_row_exits_1(monkeypatch, capsys, argv):
    store = {}
    _d1_env(monkeypatch, store)
    with pytest.raises(SystemExit) as e:
        keys.main(["keys", *argv])
    assert e.value.code == 1
    assert "no keys row in D1 yet" in capsys.readouterr().err
    assert store == {}


def test_cloudflare_mode_missing_cf_vars_exits_1(monkeypatch, capsys):
    monkeypatch.setenv("CHARTER_BACKEND", "Cloudflare")      # backend is normalised
    monkeypatch.delenv("CF_API_TOKEN", raising=False)
    monkeypatch.setattr(keys, "load_dotenv", lambda: None)
    monkeypatch.setenv("CF_ACCOUNT_ID", "x")
    monkeypatch.setenv("CF_D1_DATABASE_ID", "x")
    with pytest.raises(SystemExit) as e:
        keys._add("a", "api", ["*"])
    assert e.value.code == 1
    assert "set CF_API_TOKEN" in capsys.readouterr().err


def test_grants_push_validates_then_writes_the_row(tmp_path, monkeypatch, capsys):
    from charter.cli import grants
    store = {}
    _d1_env(monkeypatch, store)
    f = tmp_path / "grants.json"
    f.write_text('{"a@example.com": {"allow": "*"}}')      # the string-typo the engine rejects
    with pytest.raises(SystemExit):
        grants.main(["push", str(f)])
    assert "malformed entry for a@example.com" in capsys.readouterr().err
    assert store == {}
    f.write_text('{"a@example.com": {"allow": ["verbs.*"]}}')
    grants.main(["push", str(f)])
    assert store["grants"] == {"a@example.com": {"allow": ["verbs.*"]}}
    grants.main(["show"])
    assert json.loads(capsys.readouterr().out) == store["grants"]
