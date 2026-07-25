# Grants (Identity→Scope) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let charter-core derive a caller's verb allow-list from a verified Google actor identity via **grants** — the map of which verbs a named person is granted — so an OAuth'd human needs no API key.

**Architecture:** Reuse the existing actor verification (`actor_auth.actor_email`) and the Secret-Manager-cached-secret pattern (`auth.py`). Add a grants loader that maps email → allow-list, and a caller-derivation function the dispatcher tries when no API key is present. Fail-closed: no grant → no caller → 401.

**Tech Stack:** Python 3.10–3.12, pydantic-settings v2, google-cloud-secret-manager, pytest.

This is sub-project A of `docs/remote-mcp.md`. It is pure **core** work — no gateway, no MCP surface, so it is unaffected by MCP spec churn. It ships and tests standalone: verify with a fake request carrying an actor token.

**Naming:** a charter grants powers to named parties; this file is literally that. `allow` is deliberately the same field name key records use — one allow-list syntax, two ways of being identified.

## Global Constraints

- Python 3.10–3.12; no new dependencies (Secret Manager + pydantic already present).
- Fail-closed: any lookup miss or fetch error that leaves no known map yields no scope, never a permissive default.
- Secrets never appear in logs or responses (`settings.py` uses `SecretStr`; grants values are emails + verb globs, not secrets, but the loader must not log fetch payloads).
- Match existing style: module docstring explaining the *why*, `ponytail:` comments on deliberate shortcuts, tests use `FakeRequest`/`_parse` from `tests/test_bridge.py`.
- The X-API-Key path and require_actor behavior must remain byte-for-byte unchanged when no grants secret is configured.

---

### Task 1: The grants loader

**Files:**
- Create: `src/charter/grants.py`
- Modify: `src/charter/settings.py:33-34` (add `grants_secret_name`; add `charter_grants` cold-start fallback near line 52)
- Test: `tests/test_grants.py`

**Interfaces:**
- Consumes: `charter.settings.get_settings()` (fields `gcp_project`, new `grants_secret_name`, new `charter_grants`).
- Produces:
  - `grants_for(email: str) -> list[str] | None` — the allow-list granted to an email, else `None`.
  - `reload() -> None` — force next `grants_for` to re-fetch (mirrors `auth.reload`).

- [ ] **Step 1: Add settings fields**

In `src/charter/settings.py`, add beside `keys_secret_name` (line 33):

```python
    grants_secret_name: str = "charter-grants"
```

and beside `charter_keys` (line 52), the cold-start fallback:

```python
    charter_grants: SecretStr = SecretStr("")  # grants.py cold-start fallback JSON
```

- [ ] **Step 2: Write the failing test**

Create `tests/test_grants.py`:

```python
import json

import charter.grants as grants
from charter import settings as settings_mod


def _seed(monkeypatch, mapping):
    # Bypass Secret Manager: stub the fetch and force a reload.
    monkeypatch.setattr(grants, "_fetch", lambda: mapping)
    grants.reload()


def test_granted_email_gets_allow(monkeypatch):
    _seed(monkeypatch, {"jason@example.com": {"allow": ["data.*", "content.*.draft*"]}})
    assert grants.grants_for("jason@example.com") == ["data.*", "content.*.draft*"]


def test_ungranted_email_gets_none(monkeypatch):
    _seed(monkeypatch, {"jason@example.com": {"allow": ["data.*"]}})
    assert grants.grants_for("nobody@example.com") is None


def test_fetch_error_cold_start_uses_env_fallback(monkeypatch):
    monkeypatch.setenv("CHARTER_GRANTS",
                       json.dumps({"sam@example.com": {"allow": ["*"]}}))
    settings_mod.get_settings.cache_clear()

    def boom():
        raise RuntimeError("secret manager down")

    monkeypatch.setattr(grants, "_fetch", boom)
    grants.reload()
    assert grants.grants_for("sam@example.com") == ["*"]


def test_fetch_error_keeps_last_good(monkeypatch):
    _seed(monkeypatch, {"jason@example.com": {"allow": ["data.*"]}})
    assert grants.grants_for("jason@example.com") == ["data.*"]

    def boom():
        raise RuntimeError("transient blip")

    monkeypatch.setattr(grants, "_fetch", boom)
    grants.reload()  # forces re-fetch; fetch fails, last-good map must survive
    assert grants.grants_for("jason@example.com") == ["data.*"]
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pytest tests/test_grants.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'charter.grants'`

- [ ] **Step 4: Write minimal implementation**

Create `src/charter/grants.py`. This mirrors `auth.py`'s cached-secret pattern
deliberately (`ponytail:` a little duplication beats a premature shared
abstraction across two 30-line loaders):

```python
"""Grants: which verbs a named person is granted.

A charter grants powers to named parties; this is that map. The interactive
(OAuth) path carries no API key, so authorization is derived from the verified
human identity instead. Grants are a JSON map
  { "jason@example.com": {"allow": ["data.*", "content.*.draft*"]}, ... }
read LIVE from Secret Manager (`charter-grants`) and cached for TTL_SECONDS,
exactly like auth.py's key map. `allow` is the same field name key records use —
one allow-list syntax (auth.allowed), two ways of being identified.

Fail-closed: an email with no grant returns None, so the caller is None -> 401.
The CHARTER_GRANTS env var is a cold-start fallback if Secret Manager is briefly
unreachable at boot.
"""
import json
import time
import logging

from google.cloud import secretmanager

from charter.settings import get_settings

TTL_SECONDS = 60

_GRANTS = None
_loaded_at = 0.0


def _sm_client():
    c = globals().get("sm")
    if c is None:
        c = globals()["sm"] = secretmanager.SecretManagerServiceClient()
    return c


def __getattr__(name):
    if name == "sm":
        return _sm_client()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def _secret_path():
    s = get_settings()
    return f"projects/{s.gcp_project}/secrets/{s.grants_secret_name}/versions/latest"


def _fetch():
    resp = _sm_client().access_secret_version(name=_secret_path())
    return json.loads(resp.payload.data.decode("utf-8"))


def _map():
    global _GRANTS, _loaded_at
    if _GRANTS is None or (time.time() - _loaded_at) > TTL_SECONDS:
        try:
            _GRANTS = _fetch()
        except Exception as e:
            logging.error("charter grants fetch failed: %s", e)
            if _GRANTS is None:
                _GRANTS = json.loads(
                    get_settings().charter_grants.get_secret_value() or "{}")
        _loaded_at = time.time()
    return _GRANTS


def reload():
    """Force the next grants_for() to re-fetch (post-grant-edit)."""
    global _loaded_at
    _loaded_at = 0.0


def grants_for(email):
    """Allow-list granted to this email, else None (fail-closed)."""
    entry = _map().get(email)
    if entry is None:
        return None
    return entry.get("allow")
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pytest tests/test_grants.py -v`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/charter/grants.py src/charter/settings.py tests/test_grants.py
git commit -m "feat: grants loader (email -> allow, fail-closed)"
```

---

### Task 2: Derive the caller from a verified actor

**Files:**
- Modify: `src/charter/auth.py` (add `identify_by_actor`, ~end of file)
- Modify: `src/charter/main.py:19` (import), `src/charter/main.py:110-112` (fallback before the 401)
- Test: `tests/test_bridge.py` (append cases), `tests/test_grants.py` (append cases)

**Interfaces:**
- Consumes: `charter.actor_auth.actor_email(request)` (returns email, `None`, or raises `VerbError(401,"actor_invalid")`); `charter.grants.grants_for(email)`.
- Produces: `auth.identify_by_actor(request) -> dict | None` — a caller record
  `{"name": email, "interface": "oauth", "allow": [...], "require_actor": False}`,
  or `None` (no token / invalid token / no grant). Imported into `main` as
  `identify_by_actor` so the dispatcher and tests can monkeypatch it.

- [ ] **Step 1: Write the failing dispatcher tests**

Append to `tests/test_bridge.py`:

```python
# --- OAuth caller: scope derived from verified actor identity (grants) -------

def test_oauth_caller_derived_when_no_api_key(monkeypatch):
    # No API key, but a verified actor whose email holds a grant.
    monkeypatch.setattr(main, "identify", lambda req: None)
    monkeypatch.setattr(main, "identify_by_actor",
                        lambda req: {"name": "jason@example.com", "interface": "oauth",
                                     "allow": ["*"], "require_actor": False})
    monkeypatch.setattr(main, "actor_email", lambda req: "jason@example.com")
    monkeypatch.setattr(main, "record", lambda *a, **k: None)
    monkeypatch.setitem(main.VERBS, "sync.status",
                        (lambda body, caller: {"healthy": True}, "post"))
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "sync.status"})))
    assert status == 200
    assert body["ok"] is True


def test_no_key_no_grant_is_401(monkeypatch):
    # Fail-closed: no API key and no grant -> unauthorized.
    monkeypatch.setattr(main, "identify", lambda req: None)
    monkeypatch.setattr(main, "identify_by_actor", lambda req: None)
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "sync.status"})))
    assert status == 401
    assert body["error"] == "unauthorized"


def test_api_key_takes_precedence_over_actor(monkeypatch):
    # A valid API key wins; identify_by_actor is not consulted.
    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "cron", "interface": "cron", "allow": ["*"]})
    called = {"n": 0}
    monkeypatch.setattr(main, "identify_by_actor",
                        lambda req: called.__setitem__("n", called["n"] + 1))
    monkeypatch.setattr(main, "allowed", lambda caller, verb: True)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    monkeypatch.setattr(main, "record", lambda *a, **k: None)
    monkeypatch.setitem(main.VERBS, "sync.status",
                        (lambda body, caller: {"healthy": True}, "post"))
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "sync.status"})))
    assert status == 200
    assert called["n"] == 0  # actor derivation skipped when a key is present
```

- [ ] **Step 2: Write the failing `identify_by_actor` unit tests**

Append to `tests/test_grants.py`:

```python
import charter.auth as auth
from charter.errors import VerbError


class _Req:
    def __init__(self, headers):
        self.headers = headers


def test_identify_by_actor_granted_email(monkeypatch):
    monkeypatch.setattr(auth, "actor_email", lambda req: "jason@example.com")
    monkeypatch.setattr(auth, "grants_for", lambda email: ["data.*"])
    rec = auth.identify_by_actor(_Req({"X-Actor-Token": "t"}))
    assert rec == {"name": "jason@example.com", "interface": "oauth",
                   "allow": ["data.*"], "require_actor": False}


def test_identify_by_actor_no_token(monkeypatch):
    monkeypatch.setattr(auth, "actor_email", lambda req: None)
    assert auth.identify_by_actor(_Req({})) is None


def test_identify_by_actor_invalid_token(monkeypatch):
    def bad(req):
        raise VerbError(401, "actor_invalid", "rejected")
    monkeypatch.setattr(auth, "actor_email", bad)
    assert auth.identify_by_actor(_Req({"X-Actor-Token": "bad"})) is None


def test_identify_by_actor_no_grant(monkeypatch):
    monkeypatch.setattr(auth, "actor_email", lambda req: "nobody@example.com")
    monkeypatch.setattr(auth, "grants_for", lambda email: None)
    assert auth.identify_by_actor(_Req({"X-Actor-Token": "t"})) is None
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pytest tests/test_grants.py tests/test_bridge.py -v -k "actor or 401 or precedence or grant"`
Expected: FAIL — `AttributeError: module 'charter.auth' has no attribute 'identify_by_actor'` (and `main` has no `identify_by_actor`).

- [ ] **Step 4: Implement `identify_by_actor` in `auth.py`**

Add to the imports at the top of `src/charter/auth.py`:

```python
from charter.actor_auth import actor_email
from charter.grants import grants_for
from charter.errors import VerbError
```

Append at the end of `src/charter/auth.py`:

```python
def identify_by_actor(request):
    """Caller record derived from a verified actor identity (the OAuth path).

    Returns None when there is no actor token, the token is invalid, or the
    email holds no grant — so the dispatcher falls through to 401. This runs
    ONLY when identify() found no API key, so the X-API-Key path is unaffected.
    """
    try:
        email = actor_email(request)
    except VerbError:
        return None                      # present-but-bad token -> no caller
    if not email:
        return None
    allow = grants_for(email)
    if allow is None:                    # fail-closed: no grant
        return None
    return {"name": email, "interface": "oauth", "allow": allow,
            "require_actor": False}
```

- [ ] **Step 5: Wire the fallback into the dispatcher**

In `src/charter/main.py`, extend the import at line 19:

```python
from charter.auth import identify, identify_by_actor, allowed, reload as reload_keys
```

Replace `main.py:110-112`:

```python
    caller = identify(request)                 # missing/unknown key -> None
    if caller is None:
        return _json({"ok": False, "error": "unauthorized", "request_id": rid}, 401)
```

with:

```python
    caller = identify(request)                 # X-API-Key -> caller (headless)
    if caller is None:                         # no key: try the OAuth identity path
        caller = identify_by_actor(request)    # verified actor + grants
    if caller is None:
        return _json({"ok": False, "error": "unauthorized", "request_id": rid}, 401)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pytest tests/test_grants.py tests/test_bridge.py -v`
Expected: PASS (all existing bridge tests still green — the X-API-Key path is unchanged because `identify` still wins when it returns a record).

- [ ] **Step 7: Full suite**

Run: `pytest -q`
Expected: PASS. Confirms no regression in actor, verbs.list, dry-run, or pack tests.

- [ ] **Step 8: Commit**

```bash
git add src/charter/auth.py src/charter/main.py tests/test_bridge.py tests/test_grants.py
git commit -m "feat: derive caller scope from verified actor identity via grants"
```

---

### Task 3: Operational wiring + docs

**Files:**
- Create: `docs/deployment/grants.md`
- Modify: `docs/configuration.md` (add the two new env vars to the table)
- Modify: `docs/INSTALL.md` (note the grants secret as the OAuth-path prerequisite)

No code; this is the runbook that makes Task 1–2 usable. It carries a runnable curl check as its verification.

- [ ] **Step 1: Write the grants runbook**

Create `docs/deployment/grants.md`:

```markdown
# Grants (`charter-grants`)

A charter grants powers to named parties. This secret is that map: which verbs
each verified person may call. The interactive OAuth path derives a caller's
allow-list from it. Fail-closed — an email with no grant can sign in but gets no
scope (401).

## Create it

```bash
cat > /tmp/grants.json <<'JSON'
{
  "jason@yourdomain.com": {"allow": ["*"]},
  "marketer@yourdomain.com": {"allow": ["data.*", "content.*.draft*"]}
}
JSON
gcloud secrets create charter-grants --data-file=/tmp/grants.json
```

Edit later with `gcloud secrets versions add charter-grants --data-file=...`;
core picks up new versions within ~60s (its own TTL — `admin.reload_keys`
reloads the *key* map, not grants).

## `allow` syntax

Identical to API-key allow-lists — the same `auth.allowed` fnmatch globs, where
`*` spans dots. `content.*.draft*` grants draft verbs but not publish. One
allow-list syntax, two ways of being identified. See `docs/configuration.md`.

## CF Access

The public MCP endpoint is OAuth-protected; **charter-gateway** holds the
CF-Access service token to reach core. CF Access on core is unchanged — stop
distributing its credentials to humans.
```

- [ ] **Step 2: Add env vars to the config table**

In `docs/configuration.md`, add rows:

| Variable | Required | Description |
|---|---|---|
| `GRANTS_SECRET_NAME` | No | Secret Manager secret holding the email→allow grants map (default `charter-grants`) |
| `CHARTER_GRANTS` | No | Grants JSON, cold-start fallback if Secret Manager is unreachable at boot |

- [ ] **Step 3: Verify end-to-end with a real token**

Mint a Google ID token for a granted email (the repo already ships
`src/charter/cli/mint_google_token.py`), then, against a running engine
(INSTALL Step 5) with the grants secret created and NO X-API-Key:

```bash
curl -s -X POST http://localhost:8080 \
  -H "Content-Type: application/json" \
  -H "X-Actor-Token: <google-id-token>" \
  -d '{"verb": "verbs.list"}'
```

Expected: `ok: true` and a catalog scoped to that email's granted allow-list.
Repeat with an ungranted email → `unauthorized` (401). This proves the OAuth
caller path without any gateway.

- [ ] **Step 4: Commit**

```bash
git add docs/deployment/grants.md docs/configuration.md docs/INSTALL.md
git commit -m "docs: grants runbook + config + OAuth-path verify"
```

---

## Self-Review

**Spec coverage (§4.1 of `remote-mcp.md`):**
- New `charter-grants` secret, live-cached, fail-closed → Task 1. ✓
- `allow` field name shared with key records → Task 1 (docstring + runbook). ✓
- `identify` tried first, `identify_by_actor` fallback, both coexist, API key wins → Task 2 (`test_api_key_takes_precedence_over_actor`). ✓
- Synthesized caller `{name, interface:"oauth", allow, require_actor:False}` → Task 2. ✓
- require_actor irrelevant on OAuth path (caller is the actor, flag False) → Task 2 record shape. ✓
- Trust boundary / CF Access note → Task 3 runbook. ✓
- Cold-start env fallback mirrors `auth.py` → Task 1 (`test_fetch_error_cold_start_uses_env_fallback`). ✓

**Placeholder scan:** no TBD / "add error handling" / "similar to" — every code and test block is literal. ✓

**Type consistency:** `grants_for(email)->list|None`, `identify_by_actor(request)->dict|None`, caller dict keys (`name`/`interface`/`allow`/`require_actor`) match the record shape `main.bridge` already consumes (`caller.get("require_actor")`, `caller["allow"]`). `reload()` name matches `auth.reload`. Settings fields `grants_secret_name`/`charter_grants` match the env vars `GRANTS_SECRET_NAME`/`CHARTER_GRANTS` documented in Task 3. ✓

**Not covered here (by design, deferred to later sub-projects):** the gateway,
OAuth federation, the payload contract, distribution repackage + proxy removal —
sub-projects B/C/D in `docs/remote-mcp.md`.
