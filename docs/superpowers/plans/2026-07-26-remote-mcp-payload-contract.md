# Remote-MCP Sub-project C: Payload Contract — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship §4.5's resource-link-out: core auto-offloads oversized verb results to GCS and returns a `result_ref`; the gateway translates that into an MCP `resource_link` and serves `resources/read` for it by re-authorizing through core with the caller's actor token.

**Architecture:** Sub-project C of `docs/remote-mcp.md` (§4.5, §6), including the dereference surface the 2026-07-26 review demanded (§9 Q5 of the handoff): the dereference is the engine verb `result.read` — not a new core HTTP route — so it reuses `bridge()`'s auth, grants, and audit wholesale. Core holds the blob (GCS, bucket-lifecycle TTL); the gateway stays stateless and non-authoritative: it fetches the blob through the tunnel per request, with the actor token, and core enforces producer-only access. Redaction-before-truncation moves with the new fetch path (spec §4.5's ordering note).

**Tech Stack:** Python (`src/charter/`, google-cloud-storage), TypeScript Cloudflare Worker (`gateway/src/`, `@modelcontextprotocol/sdk` 1.26.0 `registerResource`/`ResourceTemplate`), Markdown docs.

## Design decisions (locked for this plan)

1. **Dereference is a verb.** Core is one `functions_framework` route (`main.py:125`); a second HTTP route would be a structural change. `result.read` goes through `bridge()` like every verb: identified, audited, read-only-guarded. The gateway's `resources/read` handler is a thin translation to `callCore("result.read", {id})`.
2. **Producer-only access, one 404.** A blob is readable only by the caller record that produced it (`caller["name"]` — email on the OAuth path, key name on the key path). Missing id and not-your-id both answer `404 result_unknown`, so existence is never confirmed to a non-owner. References are unguessable (`secrets.token_urlsafe(24)`) *and* re-checked — not capability URLs (handoff §9 Q5a).
3. **`result.read` joins `_ALWAYS_ALLOWED`.** The ownership check is stricter than any grant pattern; requiring a `result.*` grant would lock every human out of their own results. Same rationale as `verbs.list` (`main.py:42-47`).
4. **Offload is bridge-side and automatic.** Verbs keep returning plain dicts; `bridge()` measures the success envelope and offloads past `MAX_INLINE_BYTES` (default 256 KiB = 262144) when `RESULTS_BUCKET` is set. Pack authors get §4.5's contract for free; no SDK helper, no per-verb blob code.
5. **Offload is fail-open.** The verb already ran and its `ok` audit row is written; a dead bucket falls back to the inline body, which the gateway's existing 1 MB cap + `isError: true` interim behavior still bounds. (Same fail-open stance as post-audit.)
6. **TTL is the bucket's lifecycle rule (1 day).** Core never deletes; no expiry field in the envelope; the resource_link description tells the model to re-run the verb if the resource is gone.
7. **The dereference read cap is 16 MiB, gateway-side.** Resource contents are fetched by the client on request — not pushed into a model's context — so the cap is larger than the 1 MB tool-call cap, but it is still a cap, and it reuses `readCapped`'s redact-before-cut machinery (over-read by longest secret, then cut). A result over 16 MiB is unfetchable and errors honestly (spec §7.2: no heavier blob apparatus).
8. **`structuredContent`/`outputSchema` are deliberately NOT adopted in C.** The two generic tools have no per-verb output schema to declare, and the spec (2025-11-25 tools page) says structured results SHOULD also be serialized into a text block — duplicating every result's context cost. Recorded in the spec edit (Task 7); revisit with typed-verb work.
9. **Reference-in, in this repo, is documentation.** The blog/email/podcast content verbs live in the ops-bridge backend (separate repo, not this checkout); charter's own tracked packs (bigquery, airtable) already take references (table names, record ids). This plan ships the *contract* (pack-authoring docs + skills, removing the stale stdio-era `args_path`/`out_path` text from `plugin/skills/using-verbs.md:35-38`). Migrating the podcast verb to take a Drive reference server-side is follow-on work in the ops-bridge repo and is out of scope here.

## Verified platform claims (live-docs citations — do not re-derive from memory)

Checked 2026-07-26 against modelcontextprotocol.io (stable 2025-11-25; the 2026-07-28 revision is still a release candidate and changes nothing below):

- `resource_link` tool-result content block shape `{type, uri, name, description, mimeType}`; tools "MAY return links to Resources"; "Resource links returned by tools are not guaranteed to appear in the results of a `resources/list` request." — https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- `resources/read` request `{uri}`; response `contents: [{uri, mimeType, text|blob}]`; capability `{"resources": {}}`. — https://modelcontextprotocol.io/specification/2025-11-25/server/resources
- Custom URI schemes are allowed ("implementations are always free to use additional, custom URI schemes", RFC 3986-conformant) → `charter://result/<id>` is legitimate. — same resources page.
- Per-resource authorization is the server's job (Security Considerations: access controls "SHOULD be implemented for sensitive resources"); the spec offers no wire-level primitive — which is why re-authorization happens in core.
- SDK API (installed `@modelcontextprotocol/sdk@1.26.0`, confirmed in `gateway/node_modules/.../server/mcp.d.ts`): `server.registerResource(name, uriOrTemplate, config, readCallback)`; `new ResourceTemplate("charter://result/{id}", { list: undefined })` = readable but never listed. `agents@0.4.0`'s `createMcpHandler` takes the SDK's own `McpServer`, so no shimming.

## Global Constraints

- Branch: `feat/remote-mcp` (owner policy: no merge to `main` until feature-complete). Commit per task; **do not push**.
- Suites green before claiming any task done:
  - Core: `PYTHONPATH=src .venv/bin/python -m pytest -q` (baseline **171 passing**)
  - Gateway: `cd gateway && npx vitest run` (baseline **144 passing**) and `npx tsc --noEmit` (clean)
- **Invariant §2.1 untouched:** the gateway makes no authorization decision — `authHeaders` (`gateway/src/core.ts:65-76`) is not modified; the resource path always carries the actor token.
- **Redaction-before-truncation** holds on every read path, including the new 16 MiB one: redact over the over-read buffer first, cut after (`gateway/src/core.ts` `readCapped`). Never add a later truncation step without moving redaction with it.
- Any *new* platform/MCP claim beyond the verified list above must be checked against live official docs, with the citation added to `docs/remote-mcp.md`'s Sources.
- Constants, fixed: `MAX_INLINE_BYTES` default `262144`; result id = `secrets.token_urlsafe(24)` (32 url-safe chars); id regex `^[A-Za-z0-9_-]{16,64}$` (shared, both sides); URI prefix `charter://result/`; gateway fetch cap `16 << 20` bytes; blob object name `results/<id>`; error code `result_unknown` (404).

---

### Task 1: Core results store (`results.py`)

**Files:**
- Create: `src/charter/results.py`
- Create: `tests/test_results.py`
- Modify: `src/charter/settings.py` (two fields, after `audit_table` at line 36)
- Modify: `pyproject.toml` (one dependency line in the `dependencies` list)

**Interfaces:**
- Consumes: `charter.settings.get_settings()` (fields `gcp_project`, and the new `results_bucket`), `charter.errors.VerbError`.
- Produces: `results.store(body_json: str, producer: str, verb: str) -> str` (returns result id), `results.fetch(result_id: str, producer: str) -> str` (returns stored JSON string; raises `VerbError(404, "result_unknown")`), `results._ID_RE` (compiled regex, used by tests). Tasks 2–3 call these **as module attributes** (`results.store(...)`, `results.fetch(...)`) so tests can monkeypatch them.

- [ ] **Step 1: Add settings fields and the dependency**

In `src/charter/settings.py`, after `audit_table: str = "charter.audit"  # dataset.table, joined with gcp_project` (line 36), add:

```python
    # §4.5 payload offload: GCS bucket for oversized success envelopes. Empty
    # disables offload (results stay inline; the gateway truncates at 1 MB).
    results_bucket: str = ""
    # Success-envelope size above which bridge() offloads (bytes of UTF-8 JSON).
    max_inline_bytes: int = 262144
```

Add the dependency (the repo is uv-managed — `uv.lock` — so let uv edit `pyproject.toml`, update the lock, and install in one step):

```bash
uv add "google-cloud-storage>=2.10.0"
```

Verify it landed in the environment the test command uses:

```bash
PYTHONPATH=src .venv/bin/python -c "import google.cloud.storage; print('ok')"
```

If that import fails (uv synced a different venv), fall back to adding the line `"google-cloud-storage>=2.10.0",` to `dependencies` in `pyproject.toml` manually and installing with `.venv/bin/python -m pip install "google-cloud-storage>=2.10.0"`.

- [ ] **Step 2: Write the failing tests**

Create `tests/test_results.py`:

```python
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `PYTHONPATH=src .venv/bin/python -m pytest tests/test_results.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'charter.results'` (or import error).

- [ ] **Step 4: Implement `src/charter/results.py`**

```python
"""GCS-backed store for oversized verb results (docs/remote-mcp.md §4.5).

bridge() offloads any success envelope larger than max_inline_bytes here and
returns a result_ref; the engine verb result.read fetches it back,
producer-only. Objects expire via the bucket's lifecycle rule (see
docs/deployment/gcp-cloud-run.md) — core never deletes.

Access model: the reference id is unguessable (token_urlsafe) AND re-checked —
only the caller record that produced a result may read it, and a missing id
answers exactly like someone else's id, so existence is never confirmed.
"""
import re
import secrets as _secrets

from charter.errors import VerbError
from charter.settings import get_settings

# token_urlsafe(24) -> 32 url-safe chars. The regex is the shared contract with
# the gateway (results.ts pins the same one); widen both together or neither.
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")

_client = None


def _bucket():
    global _client
    if _client is None:
        from google.cloud import storage  # deferred: keep cold start lean
        _client = storage.Client(project=get_settings().gcp_project)
    return _client.bucket(get_settings().results_bucket)


def store(body_json: str, producer: str, verb: str) -> str:
    """Write one success envelope; return its unguessable id."""
    result_id = _secrets.token_urlsafe(24)
    blob = _bucket().blob(f"results/{result_id}")
    blob.metadata = {"producer": producer, "verb": verb}
    blob.upload_from_string(body_json, content_type="application/json")
    return result_id


def fetch(result_id, producer: str) -> str:
    """Read one stored envelope back, producer-only. 404 result_unknown for
    malformed, missing, expired, and not-yours alike."""
    if not isinstance(result_id, str) or not _ID_RE.fullmatch(result_id):
        raise VerbError(404, "result_unknown")
    blob = _bucket().get_blob(f"results/{result_id}")
    if blob is None or (blob.metadata or {}).get("producer") != producer:
        raise VerbError(404, "result_unknown")
    return blob.download_as_text()
```

- [ ] **Step 5: Run tests to verify they pass, then the full suite**

Run: `PYTHONPATH=src .venv/bin/python -m pytest tests/test_results.py -q` → expect 4 passed.
Run: `PYTHONPATH=src .venv/bin/python -m pytest -q` → expect 175 passed (171 + 4), no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/charter/results.py src/charter/settings.py tests/test_results.py pyproject.toml
git commit -m "feat(core): GCS results store for oversized envelopes (§4.5)

store() tags each blob with its producer and verb; fetch() re-checks the
producer and answers one 404 for missing-and-not-yours alike. TTL belongs
to the bucket lifecycle rule, not core."
```

---

### Task 2: Engine verb `result.read`

**Files:**
- Modify: `src/charter/main.py` (import at line 27 area; `_ALWAYS_ALLOWED` at line 47; handler + registration after `identity.whoami` at line 82)
- Create: `tests/test_result_read.py`

**Interfaces:**
- Consumes: `results.fetch(result_id, producer) -> str` (Task 1; called as `results.fetch(...)` module attribute).
- Produces: engine verb `result.read` — input `{"id": "<result id>"}`, success `{"ok": true, "verb": "result.read", "request_id": ..., "content": "<stored envelope JSON string>", "mime": "application/json", "target": "result:<id>"}`; errors as standard bridge envelopes (`result_unknown` 404). Registered `read=True`. Member of `_ALWAYS_ALLOWED`. Task 5's gateway `readResult` depends on the `content` field being a **string**.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_result_read.py` (FakeRequest/monkeypatch pattern from `tests/test_bridge.py`):

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PYTHONPATH=src .venv/bin/python -m pytest tests/test_result_read.py -q`
Expected: FAIL — `unknown_verb` (404) in the first two tests; `_can` False in the third.

- [ ] **Step 3: Implement in `src/charter/main.py`**

Add to the imports block (after `from charter.identity_verbs import whoami`, line 26):

```python
from charter import results
```

Replace line 47 (`_ALWAYS_ALLOWED = {"verbs.list"}`) with:

```python
# result.read joins verbs.list: its authorization is OWNERSHIP (only the caller
# record that produced a result may fetch it — enforced in results.fetch), which
# is stricter than any grant pattern; requiring a result.* grant would only lock
# humans out of their own results. Note this also bypasses the require_actor
# gate below, which is safe for the same reason: a keyless/actorless caller can
# only ever read what that same caller record produced.
_ALWAYS_ALLOWED = {"verbs.list", "result.read"}
```

After `register("identity.whoami", whoami, "post")` (line 82), add:

```python
def result_read(body, caller):
    """Fetch a previously offloaded oversized result by id (producer-only). Returns the
    stored envelope as a JSON string; meant for the gateway's resource fetch, not for
    inlining into a model's context."""
    rid_arg = body.get("id")
    content = results.fetch(rid_arg if isinstance(rid_arg, str) else "", caller["name"])
    return {"content": content, "mime": "application/json",
            "target": f"result:{rid_arg[:64] if isinstance(rid_arg, str) else ''}"}


register("result.read", result_read, "post", read=True)
```

(Keep the call as `results.fetch(...)` — module attribute — so tests and packtest can monkeypatch it.)

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

Run: `PYTHONPATH=src .venv/bin/python -m pytest tests/test_result_read.py -q` → expect 3 passed.
Run: `PYTHONPATH=src .venv/bin/python -m pytest -q` → expect 178 passed. If any pre-existing test pins the exact verb catalog or `_ALWAYS_ALLOWED` contents, update it to include `result.read` — that is this change working, not a regression.

- [ ] **Step 5: Commit**

```bash
git add src/charter/main.py tests/test_result_read.py
git commit -m "feat(core): result.read engine verb — producer-only dereference (§4.5)

Always-allowed like verbs.list: ownership is the authorization, enforced in
results.fetch, and it is stricter than any grant pattern."
```

---

### Task 3: Bridge auto-offload

**Files:**
- Modify: `src/charter/main.py` (the success return at lines 213-216, plus one helper)
- Create: `tests/test_offload.py`

**Interfaces:**
- Consumes: `results.store(body_json, producer, verb) -> str` (Task 1), settings `results_bucket` / `max_inline_bytes` (Task 1), the existing success branch (`main.py:202-216`).
- Produces: the offload envelope Task 5's gateway parser depends on — exactly `{"ok": true, "verb": <verb>, "request_id": <rid>, "result_ref": {"id": <id>, "bytes": <int>, "mime": "application/json"}}`. `bytes` is the UTF-8 byte length of the *stored* envelope.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_offload.py`:

```python
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
    assert (stored["producer"], stored["verb"]) == ("key-a", "test.big")


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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PYTHONPATH=src .venv/bin/python -m pytest tests/test_offload.py -q`
Expected: `test_oversize_success_offloads` FAILS (no `result_ref`); the inline/disable tests may already pass — that is fine, they pin the boundary.

- [ ] **Step 3: Implement in `src/charter/main.py`**

Add this helper after `_json` (line 89):

```python
def _success(verb, rid, caller, result):
    """The 200 envelope, offloading oversize bodies to the results store (§4.5).

    Runs AFTER the ok audit row: the verb's outcome is a fact by now, so a dead
    bucket must not turn a success into an error. Fail-open to the inline body —
    the gateway's 1 MB cap still bounds what can reach a model's context.
    result.read is exempt or a fetched blob would just be re-offloaded.
    """
    payload = {"ok": True, "verb": verb, "request_id": rid, **result}
    encoded = _jsonlib.dumps(payload)
    cfg = get_settings()
    if (not cfg.results_bucket or verb == "result.read"
            or len(encoded.encode()) <= cfg.max_inline_bytes):
        return (encoded, 200, {"Content-Type": "application/json"})
    try:
        ref = results.store(encoded, caller["name"], verb)
    except Exception:
        return (encoded, 200, {"Content-Type": "application/json"})
    return _json({"ok": True, "verb": verb, "request_id": rid,
                  "result_ref": {"id": ref, "bytes": len(encoded.encode()),
                                 "mime": "application/json"}}, 200)
```

Replace the success return (line 216), keeping the `record(...)` call at 214-215 exactly as is:

```python
        return _success(verb, rid, caller, result)
```

(was: `return _json({"ok": True, "verb": verb, "request_id": rid, **result}, 200)`)

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

Run: `PYTHONPATH=src .venv/bin/python -m pytest tests/test_offload.py -q` → expect 5 passed.
Run: `PYTHONPATH=src .venv/bin/python -m pytest -q` → expect 183 passed (conftest's autouse settings-cache reset keeps the env changes from leaking).

- [ ] **Step 5: Commit**

```bash
git add src/charter/main.py tests/test_offload.py
git commit -m "feat(core): auto-offload oversize success envelopes to result_ref (§4.5)

Bridge-side and automatic, so packs keep returning plain dicts. Fail-open:
a dead bucket falls back to the inline body, which the gateway's 1 MB cap
still bounds. result.read is exempt from re-offload."
```

---

### Task 4: Gateway — parameterize the read cap

**Files:**
- Modify: `gateway/src/core.ts` (`readCapped` at lines 123-176, `callCore` opts at lines 178-184)
- Modify: `gateway/test/core.test.ts` (add cases; existing cases unchanged)

**Interfaces:**
- Consumes: existing `readCapped`/`callCore`/`redact` machinery.
- Produces: `callCore(fetchImpl, cfg, verb, args, opts)` where `opts` gains `maxBytes?: number` (default `MAX_RESPONSE_BYTES`, unchanged behavior when absent). Task 5's `readResult` passes `maxBytes: RESULT_FETCH_MAX_BYTES`.

- [ ] **Step 1: Write the failing tests**

Append to `gateway/test/core.test.ts` (reuse the file's existing `fakeFetch` helper and config fixture; adjust names to match the file):

```ts
describe("callCore maxBytes override", () => {
  it("caps at opts.maxBytes and reports truncation as an error", async () => {
    const { impl } = fakeFetch(200, "a".repeat(5000));
    const r = await callCore(impl, cfg(), "v.x", {}, { actorToken: "t", maxBytes: 1024 });
    expect(r.isError).toBe(true);
    expect(r.text.endsWith("...[truncated]")).toBe(true);
    expect(new TextEncoder().encode(r.text).length).toBeLessThanOrEqual(1024);
  });

  it("passes a body under opts.maxBytes through untouched", async () => {
    const { impl } = fakeFetch(200, "a".repeat(2000));
    const r = await callCore(impl, cfg(), "v.x", {}, { actorToken: "t", maxBytes: 4096 });
    expect(r.isError).toBe(false);
    expect(r.text).toBe("a".repeat(2000));
  });

  it("redacts a secret straddling the override cut (ordering invariant)", async () => {
    const secret = "SECRETSECRETSECRETSECRET";
    const body = "a".repeat(1024 - 10) + secret + "b".repeat(200);
    const { impl } = fakeFetch(200, body);
    const c = { ...cfg(), cfAccessClientSecret: secret };
    const r = await callCore(impl, c, "v.x", {}, { actorToken: "t", maxBytes: 1024 });
    expect(r.text).not.toContain(secret.slice(0, 10)); // no unmatched half survives
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd gateway && npx vitest run test/core.test.ts`
Expected: FAIL — TypeScript/behavior: `maxBytes` not accepted / body not truncated at 1024.

- [ ] **Step 3: Implement**

In `gateway/src/core.ts`:

1. `readCapped` signature and body — replace the fixed constants with a parameter (defaulting to today's values so all existing call sites and tests are unchanged):

```ts
async function readCapped(
  res: Response,
  secrets: (string | undefined)[],
  maxBytes: number = MAX_RESPONSE_BYTES,
): Promise<CappedBody> {
```

Inside, replace `MAX_RESPONSE_BYTES` with `maxBytes` at both uses (`readLimit` at line 133, the `truncated` computation at line 163), and replace `TRUNCATE_BUDGET_BYTES` (line 174) with a local computed from the parameter:

```ts
  const budget = maxBytes - TRUNCATE_SUFFIX_BYTES - UTF8_REPLACEMENT_SLACK;
  ...
  if (truncated) text = cutToBytes(text, budget) + TRUNCATE_SUFFIX;
```

(Delete the now-unused module-level `TRUNCATE_BUDGET_BYTES` constant.)

2. `callCore` opts type gains `maxBytes?: number`, threaded through:

```ts
  opts: { readOnly?: boolean; actorToken?: string; maxBytes?: number },
  ...
  const { text, truncated } = await readCapped(res, coreSecrets(cfg), opts.maxBytes);
```

- [ ] **Step 4: Run the gateway suite and typecheck**

Run: `cd gateway && npx vitest run && npx tsc --noEmit`
Expected: 147 passing (144 + 3), tsc clean. The existing 1 MB-cap tests must pass unmodified — that is the default-parameter contract.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/core.ts gateway/test/core.test.ts
git commit -m "feat(gateway): parameterize callCore's read cap (maxBytes)

Default unchanged (1 MB). The §4.5 dereference path needs a larger cap, and
the redact-before-cut ordering must hold at any cap — pinned by test."
```

---

### Task 5: Gateway — `result_ref` detection and the dereference client (`results.ts`)

**Files:**
- Create: `gateway/src/results.ts`
- Create: `gateway/test/results.test.ts`
- Modify: `gateway/src/tools.ts` (result packing in `handleTool` at lines 93-100; `ToolResult` type at lines 75-78; one sentence in each tool description)
- Modify: `gateway/test/tools.test.ts` (add cases)

**Interfaces:**
- Consumes: `callCore` with `maxBytes` (Task 4); core's offload envelope (Task 3): `{"result_ref": {"id", "bytes", "mime"}}`; core's `result.read` response (Task 2): `{"ok": true, ..., "content": "<string>"}`.
- Produces:
  - `RESULT_URI_PREFIX = "charter://result/"`, `RESULT_ID_RE`, `RESULT_FETCH_MAX_BYTES = 16 << 20`
  - `parseResultRef(text: string): { id: string; bytes: number; mime: string } | null`
  - `readResult(fetchImpl: typeof fetch, cfg: CoreConfig, id: string, actorToken: string): Promise<CoreResult>` — resolves to the stored envelope string in `.text`
  - `handleTool` return type widens to `{ content: ContentBlock[]; isError: boolean }` where a block is `{type:"text",...}` or `{type:"resource_link", uri, name, description, mimeType}`. Task 6 registers the resource that serves these URIs.

- [ ] **Step 1: Write the failing tests**

Create `gateway/test/results.test.ts` (mirror `core.test.ts`'s `fakeFetch`/config helpers):

```ts
import { describe, expect, it } from "vitest";
import type { CoreConfig } from "../src/core.js";
import { parseResultRef, readResult, RESULT_FETCH_MAX_BYTES, RESULT_URI_PREFIX } from "../src/results.js";

const cfg = (): CoreConfig => ({
  url: "https://core.example.com",
  cfAccessClientId: "cf-id",
  cfAccessClientSecret: "cf-secret",
});

function fakeFetch(status: number, body: string) {
  const seen: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: any, init: any) => {
    seen.push({ url: String(url), init });
    return new Response(body, { status });
  }) as typeof fetch;
  return { impl, seen };
}

const ID = "A".repeat(32);

describe("parseResultRef", () => {
  it("accepts core's offload envelope", () => {
    const text = JSON.stringify({ ok: true, verb: "v", request_id: "r",
      result_ref: { id: ID, bytes: 500000, mime: "application/json" } });
    expect(parseResultRef(text)).toEqual({ id: ID, bytes: 500000, mime: "application/json" });
  });

  it.each([
    ["not json", "{{nope"],
    ["no ref field", JSON.stringify({ ok: true })],
    ["ref not an object", JSON.stringify({ result_ref: "x" })],
    ["malformed id", JSON.stringify({ result_ref: { id: "../up", bytes: 1, mime: "m" } })],
    ["missing id", JSON.stringify({ result_ref: { bytes: 1, mime: "m" } })],
  ])("rejects %s", (_name, text) => {
    expect(parseResultRef(text)).toBeNull();
  });
});

describe("readResult", () => {
  it("calls result.read with the actor token, read_only, and the big cap", async () => {
    const { impl, seen } = fakeFetch(200, JSON.stringify({ ok: true, verb: "result.read", content: "PAYLOAD" }));
    const r = await readResult(impl, cfg(), ID, "actor-token");
    expect(r).toEqual({ text: "PAYLOAD", isError: false });
    const body = JSON.parse(String(seen[0].init.body));
    expect(body).toMatchObject({ verb: "result.read", id: ID, read_only: true });
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers["X-Actor-Token"]).toBe("actor-token");
    expect(headers["X-API-Key"]).toBeUndefined();
  });

  it("rejects a malformed id without calling core", async () => {
    const { impl, seen } = fakeFetch(200, "{}");
    const r = await readResult(impl, cfg(), "../nope", "t");
    expect(r.isError).toBe(true);
    expect(seen.length).toBe(0);
  });

  it("passes through a core error (e.g. result_unknown)", async () => {
    const { impl } = fakeFetch(404, JSON.stringify({ ok: false, error: "result_unknown" }));
    const r = await readResult(impl, cfg(), ID, "t");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("result_unknown");
  });

  it("errors on a 2xx whose content field is missing or not a string", async () => {
    const { impl } = fakeFetch(200, JSON.stringify({ ok: true }));
    const r = await readResult(impl, cfg(), ID, "t");
    expect(r.isError).toBe(true);
  });
});

it("RESULT_FETCH_MAX_BYTES is 16 MiB and the prefix is the charter scheme", () => {
  expect(RESULT_FETCH_MAX_BYTES).toBe(16 << 20);
  expect(RESULT_URI_PREFIX).toBe("charter://result/");
});
```

Append to `gateway/test/tools.test.ts` (reuse its `fakeFetch` helper and existing cfg):

```ts
describe("resource-link-out (§4.5)", () => {
  const ref = { id: "A".repeat(32), bytes: 400000, mime: "application/json" };
  const envelope = JSON.stringify({ ok: true, verb: "data.warehouse.query", request_id: "r", result_ref: ref });

  it("packs a result_ref envelope as text + resource_link", async () => {
    const { impl } = fakeFetch(200, envelope);
    const r = await handleTool(impl, cfg(), TOOL_READ_NAME, { verb: "data.warehouse.query" }, "t");
    expect(r.isError).toBe(false);
    expect(r.content[0].type).toBe("text");
    const link = r.content[1] as { type: string; uri: string; mimeType?: string };
    expect(link.type).toBe("resource_link");
    expect(link.uri).toBe("charter://result/" + "A".repeat(32));
    expect(link.mimeType).toBe("application/json");
  });

  it("leaves a plain success as a single text block", async () => {
    const { impl } = fakeFetch(200, JSON.stringify({ ok: true, rows: [1] }));
    const r = await handleTool(impl, cfg(), TOOL_READ_NAME, { verb: "v" }, "t");
    expect(r.content.length).toBe(1);
    expect(r.content[0].type).toBe("text");
  });

  it("never links on an error result, even if the body looks like a ref", async () => {
    const { impl } = fakeFetch(500, envelope);
    const r = await handleTool(impl, cfg(), TOOL_READ_NAME, { verb: "v" }, "t");
    expect(r.isError).toBe(true);
    expect(r.content.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd gateway && npx vitest run test/results.test.ts test/tools.test.ts`
Expected: FAIL — `results.ts` does not exist; tools packing unchanged.

- [ ] **Step 3: Implement `gateway/src/results.ts`**

```ts
/**
 * Resource-link-out (§4.5): detect core's result_ref envelope and dereference
 * it through core with the caller's actor token.
 *
 * The dereference re-authorizes: result.read is producer-only in core, so a
 * leaked charter://result/<id> URI is useless to anyone but the caller that
 * produced it — the reference is unguessable AND re-checked, not a capability.
 *
 * The fetch cap is larger than the tool-call cap because resource contents go
 * to the CLIENT on request, not unconditionally into a model's context — but
 * it is still a cap, and redaction still runs before the cut (core.ts
 * readCapped, at any maxBytes). A result over the cap errors honestly.
 */
import { callCore, type CoreConfig, type CoreResult } from "./core.js";

export const RESULT_FETCH_MAX_BYTES = 16 << 20; // 16 MiB

export const RESULT_URI_PREFIX = "charter://result/";

/** Shared contract with core's results.py _ID_RE — widen both or neither. */
export const RESULT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export type ResultRef = { id: string; bytes: number; mime: string };

/** Core's offload envelope, or null for anything else. Strict on the id —
 * this string becomes a URI the client will echo back. */
export function parseResultRef(text: string): ResultRef | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const ref = (parsed as { result_ref?: unknown }).result_ref;
  if (typeof ref !== "object" || ref === null) return null;
  const { id, bytes, mime } = ref as { id?: unknown; bytes?: unknown; mime?: unknown };
  if (typeof id !== "string" || !RESULT_ID_RE.test(id)) return null;
  return {
    id,
    bytes: typeof bytes === "number" ? bytes : 0,
    mime: typeof mime === "string" ? mime : "application/json",
  };
}

/** Fetch one offloaded result back through core. Resolves to the stored
 * envelope string in .text; every failure is an isError CoreResult. */
export async function readResult(
  fetchImpl: typeof fetch,
  cfg: CoreConfig,
  id: string,
  actorToken: string,
): Promise<CoreResult> {
  if (!RESULT_ID_RE.test(id)) return { text: "bad result id", isError: true };
  const res = await callCore(fetchImpl, cfg, "result.read", { id }, {
    readOnly: true,
    actorToken,
    maxBytes: RESULT_FETCH_MAX_BYTES,
  });
  if (res.isError) return res;
  let content: unknown;
  try {
    content = (JSON.parse(res.text) as { content?: unknown }).content;
  } catch {
    return { text: "unparseable result.read response", isError: true };
  }
  if (typeof content !== "string") {
    return { text: "unparseable result.read response", isError: true };
  }
  return { text: content, isError: false };
}
```

- [ ] **Step 4: Implement the packing change in `gateway/src/tools.ts`**

Replace the `ToolResult` type (lines 75-78) with:

```ts
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; name: string; description: string; mimeType: string };

type ToolResult = {
  content: ContentBlock[];
  isError: boolean;
};
```

Add the import at the top: `import { parseResultRef, RESULT_URI_PREFIX } from "./results.js";`

Replace the final `return` of `handleTool` (line 100) with:

```ts
  // §4.5 resource-link-out: core offloaded this result; hand the model a
  // reference, not bytes. Only on a clean success — an error body that merely
  // looks like a ref must stay an error.
  const ref = !isError ? parseResultRef(text) : null;
  if (ref) {
    return {
      content: [
        {
          type: "text",
          text:
            `Result is ${ref.bytes} bytes — too large to inline. ` +
            `It is available as a resource if you need the full body; ` +
            `it expires, and re-running the verb regenerates it.`,
        },
        {
          type: "resource_link",
          uri: RESULT_URI_PREFIX + ref.id,
          name: `${args.verb ?? "verb"} result`,
          description: "Full verb result, offloaded by size. Read only if the inline summary is not enough.",
          mimeType: ref.mime,
        },
      ],
      isError: false,
    };
  }
  return { content: [{ type: "text", text }], isError };
```

Append one sentence to `TOOL_READ_DESCRIPTION` and `TOOL_CALL_DESCRIPTION` (both — large query results arrive through `charter_read` too):

```
"Oversized results come back as a resource_link (charter://result/<id>) — read the linked resource only if the inline summary is not enough."
```

- [ ] **Step 5: Run the gateway suite and typecheck**

Run: `cd gateway && npx vitest run && npx tsc --noEmit`
Expected: all passing (147 from Task 4 + ~10 new), tsc clean. If tsc rejects the widened content type against the SDK's `registerTool` callback return type, type the two blocks with the SDK's own `ContentBlock`/`ResourceLink` types from `@modelcontextprotocol/sdk/types.js` instead of a local union — check the installed `types.d.ts`, not memory.

- [ ] **Step 6: Commit**

```bash
git add gateway/src/results.ts gateway/src/tools.ts gateway/test/results.test.ts gateway/test/tools.test.ts
git commit -m "feat(gateway): result_ref -> resource_link, and the dereference client (§4.5)

parseResultRef is strict (the id becomes a URI); readResult re-authorizes
through core with the caller's actor token at a 16 MiB cap, redact-before-cut
preserved at any cap."
```

---

### Task 6: Gateway — register the `charter://result/{id}` resource

**Files:**
- Modify: `gateway/src/index.ts` (`buildServer` at lines 179-208; export it)
- Create: `gateway/test/index.resources.test.ts`

**Interfaces:**
- Consumes: `readResult`, `RESULT_URI_PREFIX` (Task 5); `buildServer(env, actorToken)` and `coreConfig(env)` (existing, `index.ts:156-208`).
- Produces: an MCP resource template `charter://result/{id}`, registered `{ list: undefined }` (readable, never listed — verified SDK behavior). Declaring it also makes the server advertise the `resources` capability; nothing else changes on the wire.

- [ ] **Step 1: Write the failing test**

Create `gateway/test/index.resources.test.ts`. It drives the real `McpServer` over the SDK's in-memory transport — the same registration object `createMcpHandler` serves over HTTP — with the global `fetch` stubbed to play core. **Verify the two SDK import paths against the installed package (`gateway/node_modules/@modelcontextprotocol/sdk/dist/esm/`), not memory; adjust if they differ.**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/index.js";

const ENV = {
  CHARTER_CORE_URL: "https://core.example.com",
  CF_ACCESS_CLIENT_ID: "cf-id",
  CF_ACCESS_CLIENT_SECRET: "cf-secret",
} as never; // only the fields coreConfig() reads

const ID = "A".repeat(32);

async function connect() {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  const server = buildServer(ENV, "actor-token");
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

afterEach(() => vi.unstubAllGlobals());

describe("charter://result/{id} resource", () => {
  it("reads an offloaded result end to end, carrying the actor token", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", (async (url: unknown, init: unknown) => {
      seen.push({ url: String(url), init: init as RequestInit });
      return new Response(
        JSON.stringify({ ok: true, verb: "result.read", content: "BIGPAYLOAD" }),
        { status: 200 },
      );
    }) as typeof fetch);

    const client = await connect();
    const res = await client.readResource({ uri: `charter://result/${ID}` });
    expect(res.contents[0]).toMatchObject({
      uri: `charter://result/${ID}`,
      mimeType: "application/json",
      text: "BIGPAYLOAD",
    });
    const body = JSON.parse(String(seen[0].init.body));
    expect(body).toMatchObject({ verb: "result.read", id: ID, read_only: true });
    expect((seen[0].init.headers as Record<string, string>)["X-Actor-Token"]).toBe("actor-token");
  });

  it("surfaces core's result_unknown as a resources/read error", async () => {
    vi.stubGlobal("fetch", (async () =>
      new Response(JSON.stringify({ ok: false, error: "result_unknown" }), { status: 404 })
    ) as typeof fetch);
    const client = await connect();
    await expect(client.readResource({ uri: `charter://result/${ID}` })).rejects.toThrow(/result_unknown/);
  });

  it("does not list the template's resources", async () => {
    vi.stubGlobal("fetch", (async () => new Response("{}", { status: 500 })) as typeof fetch);
    const client = await connect();
    const listed = await client.listResources();
    expect(listed.resources).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npx vitest run test/index.resources.test.ts`
Expected: FAIL — `buildServer` not exported / no resource registered (readResource rejects with "not found" or a method-not-supported error).

- [ ] **Step 3: Implement in `gateway/src/index.ts`**

Add imports: `ResourceTemplate` beside the existing `McpServer` import, and `import { readResult, RESULT_URI_PREFIX } from "./results.js";`

Export `buildServer` (change `function buildServer` to `export function buildServer` — the comment above it already explains the actor-token contract).

Inside `buildServer`, after the two `registerTool` calls (line 206), add:

```ts
  // §4.5 resource-link-out: the dereference surface for offloaded results.
  // { list: undefined } = readable, never listed — a result id is one caller's
  // one-off artifact, not a catalog entry. The read re-authorizes through core
  // (result.read is producer-only), carrying this request's actor token; the
  // gateway still decides nothing and stores nothing (§2.1, §2.4).
  server.registerResource(
    "result",
    new ResourceTemplate(`${RESULT_URI_PREFIX}{id}`, { list: undefined }),
    {
      title: "Offloaded verb result",
      description:
        "Full body of a verb result that was too large to inline. Expires; re-run the verb to regenerate.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = String(variables.id ?? "");
      const r = await readResult(fetch, coreConfig(env), id, actorToken);
      if (r.isError) throw new Error(r.text);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: r.text }],
      };
    },
  );
```

(`ResourceTemplate` import path: same module as `McpServer` — verify against the installed SDK if tsc disagrees.)

- [ ] **Step 4: Run the full gateway suite and typecheck**

Run: `cd gateway && npx vitest run && npx tsc --noEmit`
Expected: all passing, tsc clean. The pre-existing `index.spike.test.ts` must still pass — `buildServer`'s export changes nothing at runtime.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/index.ts gateway/test/index.resources.test.ts
git commit -m "feat(gateway): serve charter://result/{id} via resources/read (§4.5)

Unlisted resource template; every read goes back through core with the
caller's actor token, so authorization stays where it lives."
```

---

### Task 7: Docs — spec, runbooks, config reference, pack contract, skills

**Files:**
- Modify: `docs/remote-mcp.md` (§4.5 interim paragraphs at lines 306-320; §6 C row at line 531; Sources)
- Modify: `docs/configuration.md` (core variables table)
- Modify: `docs/deployment/gcp-cloud-run.md` (new section: results bucket)
- Modify: `docs/deployment/gateway.md` (surface note in the relevant section — find "tools" or "surface"; known-limitations entry for the 16 MiB cap)
- Modify: `docs/pack-authoring.md` (new section after "Handler Result Conventions", line 46-54)
- Modify: `plugin/skills/pack-authoring.md` (one bullet)
- Modify: `plugin/skills/using-verbs.md` (replace the "Large Payloads" section, lines 35-38)

No code changes; both suites must still pass at the end (they will — run them anyway before committing).

- [ ] **Step 1: Update `docs/remote-mcp.md` §4.5**

Replace the two paragraphs "**What ships until C does…**" through "…returns a reference instead." (lines 306-315), keeping the ordering-note paragraph (317-320) as the section's final word, with:

```markdown
**What C shipped: automatic offload + `result.read` + a gateway resource.**
Core's `bridge()` measures every success envelope; past `MAX_INLINE_BYTES`
(default 256 KiB) with `RESULTS_BUCKET` configured, the body is written to GCS
(`src/charter/results.py` — producer- and verb-tagged, unguessable id) and the
response becomes `{"ok": true, "verb", "request_id", "result_ref": {"id",
"bytes", "mime"}}`. The gateway translates that envelope into an MCP
`resource_link` (`charter://result/<id>`, a custom scheme the spec permits)
and serves `resources/read` for it — an unlisted resource template — by
calling the engine verb `result.read` with the caller's actor token. A
dereference therefore re-authorizes through core like any other call:
`result.read` is always-allowed (like `verbs.list`) because its authorization
is *ownership* — core returns a blob only to the caller record that produced
it, and a missing id answers exactly like someone else's id (`result_unknown`,
404). References are unguessable *and* re-checked, not capability URLs.
Objects expire by bucket lifecycle rule (one day — the deployment runbook owns
it); core never deletes, and a vanished resource means "re-run the verb."

Offload is fail-open and bridge-side: verbs keep returning plain dicts, so
the authoring contract above costs pack authors nothing, and a dead bucket
falls back to the inline body — which the gateway's 1 MB cap still bounds,
with `isError: true` on truncation, exactly the pre-C interim behaviour, now
as defense in depth. The dereference path reads at a larger cap (16 MiB,
`gateway/src/results.ts`) because resource contents are fetched by the client
on request rather than pushed into a model's context; a result past that cap
fails honestly (§7.2 — no heavier blob apparatus). `structuredContent` +
`outputSchema` remain deliberately unadopted: the two generic tools have no
per-verb output schema to declare, and the spec has structured results also
serialized into a text block, doubling their context cost — revisit with
typed-verb work, not before.
```

In §6's table (line 531), C's "Detailed plan" cell: `**landed** (plan: plans/2026-07-26-remote-mcp-payload-contract.md)` — set this only in the execution session that actually lands it; if editing before that, write `**written** (plans/2026-07-26-remote-mcp-payload-contract.md)`.

Add to Sources (matching the existing citation format):

```markdown
- MCP resources (2025-11-25): resources/read contract, custom URI schemes
  permitted, access control is the server's (SHOULD).
  https://modelcontextprotocol.io/specification/2025-11-25/server/resources
```

(The tools-page citation for `resource_link` already exists in Sources if §4.5 cited it; add it likewise if absent.)

- [ ] **Step 2: Update `docs/configuration.md`**

Add two rows to the core variables table, matching its existing column format:

- `RESULTS_BUCKET` — optional, default empty. GCS bucket for §4.5 result offload. Empty disables offload: oversized results stay inline and the gateway truncates at 1 MB with an error.
- `MAX_INLINE_BYTES` — optional, default `262144`. Success-envelope size (UTF-8 JSON bytes) above which `bridge()` offloads to `RESULTS_BUCKET`.

- [ ] **Step 3: Update `docs/deployment/gcp-cloud-run.md`**

Add a section (place it beside the other GCP resource setup, e.g. after the audit/BigQuery setup):

```markdown
## Results bucket (§4.5 payload offload)

Oversized verb results are offloaded to GCS and fetched back by reference
(`result.read`). One bucket, private, with a lifecycle rule doing the
expiry — core never deletes.

    gcloud storage buckets create gs://$PROJECT-charter-results \
      --project $PROJECT --location $REGION --uniform-bucket-level-access

    cat > /tmp/charter-results-lifecycle.json <<'EOF'
    {"rule": [{"action": {"type": "Delete"}, "condition": {"age": 1}}]}
    EOF
    gcloud storage buckets update gs://$PROJECT-charter-results \
      --lifecycle-file=/tmp/charter-results-lifecycle.json

    gcloud storage buckets add-iam-policy-binding gs://$PROJECT-charter-results \
      --member "serviceAccount:$RUNTIME_SA" --role roles/storage.objectAdmin

Then set `RESULTS_BUCKET=$PROJECT-charter-results` on the service. Leave it
unset to disable offload (results stay inline; the gateway truncates at 1 MB).
```

Verification norm applies: check the three `gcloud storage` invocations against live gcloud docs before committing; fix any drifted flag names in the runbook text.

- [ ] **Step 4: Update `docs/deployment/gateway.md`**

Two edits, matching the runbook's voice:
1. Where the MCP surface is described (the two tools), add: the gateway also serves one unlisted resource template, `charter://result/{id}`, backed by core's `result.read` with the caller's actor token — no new secrets, no new state; deployments without `RESULTS_BUCKET` on core simply never emit a `result_ref`, and the resource surface sits idle.
2. In known limitations: a result over 16 MiB is unfetchable through the gateway (`RESULT_FETCH_MAX_BYTES`); the `resources/read` call errors honestly. Raise the constant only with a reason.

- [ ] **Step 5: Update the pack contract docs**

`docs/pack-authoring.md` — insert after "Handler Result Conventions" (before "The dry_run Convention"):

```markdown
## Payload Contract

Reference in, reference out (docs/remote-mcp.md §4.5):

- **Large inputs go by reference.** Take an id or URI and dereference inside
  the handler (a Drive file id, a table name, a deal id) — never declare an
  inline-base64 or large-body argument. The model authors small JSON;
  pre-existing artifacts arrive as references.
- **Large outputs are offloaded for you.** Return a plain dict. When the
  deployment configures `RESULTS_BUCKET`, any success envelope over
  `MAX_INLINE_BYTES` is stored server-side and the caller gets a `result_ref`
  the gateway serves as an MCP resource. Do not build per-verb blob handling.
- **Prefer diagnostics + a preview over bulk.** A verb that assembles a large
  body should return its counts and byte size, not the body — the caller can
  fetch the reference if it needs everything.
- packtest's 1 MB response-budget check still applies to what you return:
  it keeps a pack honest on deployments that run without a results bucket.
```

`plugin/skills/pack-authoring.md` — add one bullet in the same spirit wherever result conventions are listed: "Large inputs by reference (id/URI, dereferenced in the handler); large outputs return automatically as a `result_ref` — never build per-verb blob handling."

- [ ] **Step 6: Replace `plugin/skills/using-verbs.md` "Large Payloads" (lines 35-38)**

```markdown
## Large Payloads

- Large **inputs** go by reference: pass an id or URI the verb dereferences
  (a Drive file id, a table name) — never paste a large body into args.
- Large **results** come back as a `resource_link` (`charter://result/<id>`)
  instead of inline JSON. Read the linked resource only if the inline summary
  is not enough — it is the full body. Links expire and are readable only by
  the caller that produced them; if one is gone, re-run the verb.
```

(This deletes the stale stdio-era `args_path`/`out_path` rows — the proxy they belonged to was removed in sub-project D.)

- [ ] **Step 7: Run both suites, then commit**

```bash
PYTHONPATH=src .venv/bin/python -m pytest -q
cd gateway && npx vitest run && npx tsc --noEmit && cd ..
git add docs/remote-mcp.md docs/configuration.md docs/deployment/gcp-cloud-run.md \
  docs/deployment/gateway.md docs/pack-authoring.md plugin/skills/pack-authoring.md \
  plugin/skills/using-verbs.md
git commit -m "docs: payload contract shipped — spec §4.5, runbooks, pack contract, skills (§4.5)

using-verbs.md loses the stdio-era args_path/out_path rows; the reference-in
half of C is this contract — the content verbs that adopt it live in the
ops-bridge backend, out of this repo."
```

---

## Out of scope (recorded so nobody "helpfully" adds them)

- **Podcast verb migration** (Drive-reference in, transcript formatting + glossary linking server-side): lives in the ops-bridge backend repo, not this checkout. Follow-on work there; the contract it implements is Task 7's docs.
- **`structuredContent`/`outputSchema`** — deliberate deferral (design decision 8).
- **Blob listing, deletion verbs, per-object TTL, SEP-2631 upload flow** — YAGNI until something needs them (§7.2).
- **packtest changes** — the response-budget check stays as-is; it guards bucket-less deployments (Task 7 documents the interplay).
- The handoff's §10 items 3-5 (wiring-order tests, federated-flow abstraction, PKCE/CIMD/write-back) are separate work, not C.
