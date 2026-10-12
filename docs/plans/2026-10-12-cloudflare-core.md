# Plan: charter core on Cloudflare Containers (plan:cloudflare-core)

**Goal:** the open-source engine runs in a Cloudflare Container behind the existing gateway Worker. Keys/grants come from env, audit goes to D1, one `npx wrangler deploy` from `gateway/` ships both. GCP mode keeps working unchanged (RC prod stays on it until phase 2).
**Design:** scratchpad `s_dm37wzpefp681` (tags `design`, `cloudflare-only`).
**Repo:** `/Users/jasonrosoff/Code/charter`. **Branch:** `feat/cloudflare-core`.
**Verify (whole feature):** `.venv/bin/pytest -q && (cd gateway && npm run typecheck && npm test)` — then the live smoke in Task 9.

**Setup in a fresh worktree** (no setup script exists, learning `s_dlbs1rpap4u04`): `python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"` and `cd gateway && npm ci`. Run pytest as `.venv/bin/pytest`. Reviewed 2026-10-12 by two subagents; their findings are folded in below (validator mode, container-by-name, CLI env read, `/call` hardening, doc passages).

## Decisions the implementer must not re-open

- One switch: env `CHARTER_BACKEND` = `gcp` (default, today's behaviour) | `cloudflare`. In `cloudflare` mode: keys/grants come only from `CHARTER_KEYS`/`CHARTER_GRANTS` env; audit rows go to D1 via the REST API; `GCP_PROJECT` is not required; `RESULTS_BUCKET` stays empty (inline results only; `results.py` is GCS-only and untouched).
- Audit is written **by core** through the D1 HTTP API (`POST https://api.cloudflare.com/client/v4/accounts/{acct}/d1/database/{db}/query`, `Authorization: Bearer <token>`, body `{"sql","params"}`), so the fail-closed `pre` audit in `main.py:302-312` is untouched. Resolves todo `t_dm37x2y9ckw83`.
- All container env comes from Worker vars/secrets prefixed `CORE_` (prefix stripped), plus three fixed values: `PORT=8080`, `CHARTER_BACKEND=cloudflare`, `GOOGLE_OAUTH_CLIENT_ID=<env.GOOGLE_CLIENT_ID>`. `wrangler secret put CORE_CHARTER_KEYS` is how keys reach core. Pack config travels the same way (`CORE_PACKS`, `CORE_AIRTABLE_BASE_ID`, …).
- **Secret rotation = a new container, not a restart.** The Worker names the container instance by a hash of its `CORE_*` env (`core-<sha256[:16]>`). A changed secret means a new name → a fresh container with the new env; all new requests go there at once, so a revoked key stops working on the next request. The old instance idles out after `sleepAfter`. No DO storage, no `stop()`, no race. `max_instances: 2` covers the overlap.
- The Durable Object holds **no state** (the container library uses it only as the lifecycle handle). The "stateless gateway" invariant (`docs/remote-mcp.md:79-80`, `:607-611`, `:727`) stands; Task 8 updates all three passages. **Accepted trade-off, stated in the docs:** the Worker now carries core's secrets as `CORE_*` secrets in the same deploy; a gateway-side leak would expose them. Jason accepted "less machinery" over this separation (design `s_dm37wzpefp681`).
- Gateway → core goes over the DO binding `CHARTER_CORE`. `callCore` (`gateway/src/core.ts:188`) is unchanged: it keeps its `fetchImpl` parameter and https check; we hand it a fetch that targets the container stub with the fixed URL `https://charter-core.internal/`. When the binding is absent (GCP mode, tests) `CHARTER_CORE_URL` + global `fetch` keep working.
- `POST /call` is a new headless passthrough on the gateway, **container mode only** (falls through to the existing 404 when there is no `CHARTER_CORE` binding). Forwards body + `X-API-Key` + `traceparent`; 401 without `X-API-Key`; 413 over 1 MiB; 502 JSON if the container call throws. No CF Access on it (design cut); the runbook tells adopters to add a WAF rate-limiting rule on `/call`.
- Gateway tests run against `gateway/wrangler.test.jsonc` (same file minus `containers`/`durable_objects`/`migrations`) because the vitest pool would otherwise try to build the image. Container routing is unit-tested with a fake namespace. `gateway/wrangler.staging.jsonc` (git-ignored, RC-only) stays GCP-origin and is not touched.
- Versions: add `@cloudflare/containers@0.3.7` (exact; its `Container` class has `defaultPort`, `sleepAfter`, `envVars`, `fetch(request)`, verified from the published `.d.ts`). Keep `wrangler 4.107.0` and `@cloudflare/vitest-pool-workers 0.12.21` unless the Task 7 dry run rejects the `containers` block; then bump to `wrangler@4.149.0` and the newest `@cloudflare/vitest-pool-workers` together in one commit.
- No GitHub Actions in this repo (none exist today). Deploy is documented as a command.

## Task 1 — settings: `CHARTER_BACKEND` + Cloudflare fields  (`sonnet`)

**Exists because:** every other task branches on it, and `main.py:35` calls `get_settings()` at import so `GCP_PROJECT` must stop being required in cloudflare mode or the container cannot boot.
**Files:** `src/charter/settings.py`, `tests/test_settings.py`, `docs/configuration.md`.
**Follows:** field style `settings.py:28-71` (SecretStr defaults are `SecretStr("")`, e.g. line 64), validator style `:73-88`; tests use `Settings(_env_file=None)` + `_clear_required`/`_set_required` helpers (`tests/test_settings.py:17-36`). The file imports `from charter.settings import Settings, get_settings` (line 14) — there is no `settings_mod` name.

Why `mode="before"`: an `after` validator does not run when another required field is missing, so `test_missing_required_value_fails_fast_with_named_field` (line 33) and `test_main_fails_fast_at_startup_without_required_config` (line 164), which both assert `"gcp_project"` in the error, would fail. Verified on the repo venv (pydantic 2.13.4): before → message present, after → absent.

Test first (append to `tests/test_settings.py`):
```python
# --- CHARTER_BACKEND ------------------------------------------------------------

def test_backend_defaults_to_gcp(monkeypatch):
    _set_required(monkeypatch)
    assert Settings(_env_file=None).charter_backend == "gcp"

def test_cloudflare_backend_does_not_need_gcp_project(monkeypatch):
    _set_required(monkeypatch)
    monkeypatch.delenv("GCP_PROJECT", raising=False)
    monkeypatch.setenv("CHARTER_BACKEND", "cloudflare")
    monkeypatch.setenv("CF_ACCOUNT_ID", "acct")
    monkeypatch.setenv("CF_D1_DATABASE_ID", "db")
    monkeypatch.setenv("CF_API_TOKEN", "tok")
    s = Settings(_env_file=None)
    assert s.gcp_project == "" and s.charter_backend == "cloudflare"
    assert s.cf_api_token.get_secret_value() == "tok"

def test_cloudflare_backend_requires_cf_fields(monkeypatch):
    _set_required(monkeypatch)
    monkeypatch.setenv("CHARTER_BACKEND", "cloudflare")
    for k in ("CF_ACCOUNT_ID", "CF_D1_DATABASE_ID", "CF_API_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    with pytest.raises(Exception) as e:
        Settings(_env_file=None)
    assert "CF_ACCOUNT_ID" in str(e.value) and "tok" not in str(e.value)

def test_unknown_backend_rejected(monkeypatch):
    _set_required(monkeypatch)
    monkeypatch.setenv("CHARTER_BACKEND", "aws")
    with pytest.raises(Exception):
        Settings(_env_file=None)
```
(`_set_required(monkeypatch)` at line ~30 sets all three required vars; check its exact signature — it may take a `project` kwarg with a default.)

Implementation in `settings.py`:
- `gcp_project: str = ""` (was required; keep its comment).
- New fields right after it: `charter_backend: str = "gcp"`, `cf_account_id: str = ""`, `cf_d1_database_id: str = ""`, `cf_api_token: SecretStr = SecretStr("")`.
- Add (import `model_validator` from `pydantic`):
```python
@model_validator(mode="before")
@classmethod
def _check_backend(cls, values):
    # "before" on purpose: an "after" validator is skipped when any required
    # field is missing, and the boot error must still name gcp_project.
    if not isinstance(values, dict):
        return values
    backend = values.get("charter_backend", "gcp")
    if backend == "gcp":
        if not values.get("gcp_project"):
            raise ValueError("gcp_project (GCP_PROJECT) is required when CHARTER_BACKEND=gcp")
    elif backend == "cloudflare":
        missing = [n for n, k in (("CF_ACCOUNT_ID", "cf_account_id"),
                                   ("CF_D1_DATABASE_ID", "cf_d1_database_id"),
                                   ("CF_API_TOKEN", "cf_api_token")) if not values.get(k)]
        if missing:
            raise ValueError(f"CHARTER_BACKEND=cloudflare needs {', '.join(missing)}")
    else:
        raise ValueError(f"CHARTER_BACKEND must be 'gcp' or 'cloudflare', got {backend!r}")
    return values
```
`conftest.py:7-9` sets `GCP_PROJECT`, so the existing suite stays in gcp mode.
- `docs/configuration.md`: in the Required table change the `GCP_PROJECT` description to "Required when `CHARTER_BACKEND=gcp` (the default); unused in cloudflare mode"; add to Optional: `CHARTER_BACKEND` (`gcp`; `gcp` | `cloudflare`), `CF_ACCOUNT_ID`, `CF_D1_DATABASE_ID`, `CF_API_TOKEN` (all "cloudflare mode: required; D1 audit log").

**Verify:** `.venv/bin/pytest -q tests/test_settings.py`

## Task 2 — secret_map: env is the source in cloudflare mode  (`sonnet`)

**Exists because:** today `_fetch` calls Secret Manager; in cloudflare mode that raises every 60 s, logs ERROR each time, and only works by accident via the cold-start fallback.
**Files:** `src/charter/secret_map.py`, `tests/test_secret_map.py`.
**Follows:** `SecretMap._fetch` / `_from_env` at `secret_map.py:52-108`; test style `tests/test_secret_map.py:23-43`. That file imports `charter.auth as auth` and `from charter import settings as settings_mod` only — add `from charter import grants, secret_map`.

Test first (append to `tests/test_secret_map.py`). `get()` swallows every `_fetch` exception, so the test must count calls, not raise:
```python
def _cloudflare_env(monkeypatch):
    monkeypatch.setenv("CHARTER_BACKEND", "cloudflare")
    monkeypatch.setenv("CF_ACCOUNT_ID", "a")
    monkeypatch.setenv("CF_D1_DATABASE_ID", "d")
    monkeypatch.setenv("CF_API_TOKEN", "t")
    settings_mod.get_settings.cache_clear()

def test_cloudflare_backend_reads_keys_from_env_without_secret_manager(monkeypatch):
    _cloudflare_env(monkeypatch)
    monkeypatch.setenv("CHARTER_KEYS", '{"sha256:abc": {"name": "k", "interface": "api", "allow": ["verbs.list"]}}')
    calls = []
    monkeypatch.setattr(secret_map, "_sm_client", lambda: calls.append(1))
    auth._MAP.reset()
    assert "sha256:abc" in auth._MAP.get()
    auth._MAP.reload()
    assert "sha256:abc" in auth._MAP.get()
    assert calls == []            # Secret Manager never touched, even on reload

def test_cloudflare_backend_reads_grants_from_env(monkeypatch):
    _cloudflare_env(monkeypatch)
    monkeypatch.setenv("CHARTER_GRANTS", '{"a@example.com": {"allow": ["verbs.list"]}}')
    calls = []
    monkeypatch.setattr(secret_map, "_sm_client", lambda: calls.append(1))
    grants._MAP.reset()
    assert grants.grants_for("a@example.com") == ["verbs.list"]
    assert calls == []
```
(`grants.grants_for` returns the validated allow list — confirm its return shape at `grants.py:32-46` and adjust the assertion to it; the `calls == []` line is the real check.)

Implementation: first lines of `SecretMap._fetch`:
```python
if get_settings().charter_backend == "cloudflare":
    return self._from_env()
```
Nothing else changes; `get()`'s dict check and TTL stay.

**Verify:** `.venv/bin/pytest -q tests/test_secret_map.py tests/test_grants.py`

## Task 3 — audit: D1 sink  (`sonnet`)

**Exists because:** `record()` is BigQuery-only; without a D1 path every call in cloudflare mode logs an audit failure and every `pre`-audited verb returns 503.
**Files:** `src/charter/audit.py`, `tests/test_audit_d1.py` (new), `sql/audit_table.d1.sql` (new).
**Follows:** `record()` at `audit.py:73-106` (`get_settings` already imported there); `requests` usage as in `src/charter/improve.py`; fake-client test style `tests/test_audit_trace.py:17-38`.

`sql/audit_table.d1.sql` (same columns as `sql/audit_table.sql`):
```sql
-- D1 twin of audit_table.sql. Apply: npx wrangler d1 execute charter-audit --remote --file ../sql/audit_table.d1.sql
CREATE TABLE IF NOT EXISTS audit (
  ts TEXT NOT NULL, actor TEXT, interface TEXT, verb TEXT, target TEXT, result TEXT,
  detail TEXT, request_id TEXT, on_behalf_of TEXT, credential TEXT, traceparent TEXT
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts);
```

Test first, `tests/test_audit_d1.py`:
```python
import pytest
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
    def ok(self): return self.status_code < 400
    def json(self):
        if isinstance(self._b, Exception): raise self._b
        return self._b

def test_d1_insert_shape(cf, monkeypatch):
    calls = []
    def post(url, headers=None, json=None, timeout=None):
        calls.append((url, headers, json)); return _Resp(200, {"success": True, "result": []})
    monkeypatch.setattr(audit.requests, "post", post)
    audit.record({"name": "k", "interface": "api"}, "verbs.list", None, "ok", rid="r1")
    url, headers, body = calls[0]
    assert url == "https://api.cloudflare.com/client/v4/accounts/acct1/d1/database/db1/query"
    assert headers["Authorization"] == "Bearer tok1"
    assert body["sql"].startswith("INSERT INTO audit (")
    cols = body["sql"].split("(")[1].split(")")[0].split(", ")
    assert "target" not in cols                      # None values are omitted → NULL
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
```

Implementation in `audit.py`:
- `import requests` at top (declared dependency; needs no credentials, so `test_settings.py:136-161`'s scrubbed import still passes).
- Add:
```python
_D1_URL = "https://api.cloudflare.com/client/v4/accounts/{acct}/d1/database/{db}/query"

def _d1_insert(row):
    s = get_settings()
    row = {k: v for k, v in row.items() if v is not None}   # absent column → NULL
    cols = list(row)                                         # fixed literals from record(), never caller input
    sql = f"INSERT INTO audit ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})"
    r = requests.post(
        _D1_URL.format(acct=s.cf_account_id, db=s.cf_d1_database_id),
        headers={"Authorization": f"Bearer {s.cf_api_token.get_secret_value()}",
                 "Content-Type": "application/json"},
        json={"sql": sql, "params": [row[c] for c in cols]},
        timeout=(3, 5),      # connect, read: a dead D1 fails 'pre' audit in ≤8 s, not 10
    )
    try:
        body = r.json() if r.content else {}
    except ValueError:
        body = {}
    if not r.ok or not body.get("success"):
        raise RuntimeError(f"d1 audit insert failed: HTTP {r.status_code} {body.get('errors')}")
```
Table name is the literal `audit` (`AUDIT_TABLE` is ignored in cloudflare mode; Task 8 documents it).
- In `record()`, replace the two lines inside `try:` with:
```python
if get_settings().charter_backend == "cloudflare":
    _d1_insert(row)
else:
    errors = _client().insert_rows_json(_table(), [row])
    if errors:
        raise RuntimeError(f"audit insert errors: {errors}")
```
The `except` / `fail_open` logic below is untouched.

**Verify:** `.venv/bin/pytest -q tests/test_audit_d1.py tests/test_audit_trace.py tests/test_bridge.py tests/test_settings.py`

## Task 4 — CLI keys: file-backed store in cloudflare mode  (`sonnet`)

**Exists because:** `charter keys add/rotate/revoke/list` write to Secret Manager; a Cloudflare adopter has no Secret Manager and Worker secrets are write-only, so the key map must live in a local file the operator pushes with `wrangler secret put`.
**Files:** `src/charter/cli/keys.py`, `tests/test_cli_keys.py`, `.gitignore` (add `charter-keys.json`, `charter-grants.json`).
**Follows:** `_fetch_keys`/`_store_keys` at `cli/keys.py:34-46`; `_mint` reads `os.environ` directly "because mint must work before Step 3 config" (`cli/keys.py:130-132`) — the cloudflare branch does the same, so minting a key needs no `GOOGLE_OAUTH_CLIENT_ID`/`ALLOWED_DOMAIN`/`CF_*`. `os`, `sys`, `json` are already imported (lines 13-18); add `import pathlib`. Test fake at `tests/test_cli_keys.py:9-25`.

Test first (append to `tests/test_cli_keys.py`; it already imports `json` and `keys` — check line 1-8 and add `import json` only if absent):
```python
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
    assert "wrangler secret put CORE_CHARTER_KEYS" in capsys.readouterr().err
    keys._revoke(name="agent-a")
    assert json.loads((tmp_path / "keys.json").read_text()) == {}
```

Implementation in `cli/keys.py`:
```python
def _file_mode():
    # Read env directly, like _mint: the CLI must work before engine config exists.
    return os.environ.get("CHARTER_BACKEND", "gcp") == "cloudflare"

def _keys_file():
    return pathlib.Path(os.environ.get("KEYS_FILE", "charter-keys.json"))

def _fetch_keys():
    if _file_mode():
        p = _keys_file()
        return json.loads(p.read_text()) if p.exists() else {}
    client = _sm_client()                                   # ← keep lines 34-38 exactly as they are today
    ...

def _store_keys(keys):
    if _file_mode():
        p = _keys_file()
        p.write_text(json.dumps(keys, indent=2) + "\n")
        print(f"wrote {p}. Push it with: npx wrangler secret put CORE_CHARTER_KEYS < {p}", file=sys.stderr)
        return
    client = _sm_client()                                   # ← keep lines 41-46 exactly as they are today
    ...
```
"`...`" means the existing Secret Manager body of that function, unchanged. `_list`, `_rotate`, `_revoke` go through `_fetch_keys`/`_store_keys` and need no edits (confirm at 74-115). `_mint` untouched. Update the module docstring (line 1) to mention the file backend. `docs/configuration.md`: add `KEYS_FILE` (default `charter-keys.json`; cloudflare mode only).

**Verify:** `.venv/bin/pytest -q tests/test_cli_keys.py`

## Task 5 — gateway: Container class + core routing over the binding  (`sonnet`)

**Exists because:** without it the Worker has no way to reach a container; `CHARTER_CORE_URL` would still point at a public origin.
**Files:** `gateway/src/container.ts` (new), `gateway/src/index.ts`, `gateway/package.json` (+ lockfile), `gateway/test/container.test.ts` (new).
**Follows:** `coreConfig(env)` at `index.ts:199-210`; the two call sites that pass global `fetch` — `handleTool(fetch, …)` inside the `run` closure near line 237 and `readResult(fetch, …)` near line 283 (grep `fetch,` to find both); `Env` type at `index.ts:77-136`; unit-test style `gateway/test/core.test.ts:4-21`.

`cd gateway && npm install --save-exact @cloudflare/containers@0.3.7`.

`gateway/src/container.ts`:
```ts
import { Container } from "@cloudflare/containers";
import type { Env } from "./index";

export const CORE_URL = "https://charter-core.internal/";
const PREFIX = "CORE_";

/** Container env = every CORE_* Worker var/secret (prefix stripped) + three fixed values. */
export function coreEnv(env: Record<string, unknown>, googleClientId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith(PREFIX) && typeof v === "string") out[k.slice(PREFIX.length)] = v;
  }
  out.PORT = "8080";
  out.CHARTER_BACKEND = "cloudflare";
  out.GOOGLE_OAUTH_CLIENT_ID = googleClientId;
  return out;
}

/** Instance name = hash of the env. A changed secret → a new name → a fresh container. */
export async function instanceName(vars: Record<string, string>): Promise<string> {
  const canon = JSON.stringify(Object.keys(vars).sort().map((k) => [k, vars[k]]));
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon));
  const hex = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `core-${hex.slice(0, 16)}`;
}

export class CharterCore extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.envVars = coreEnv(env as unknown as Record<string, unknown>, env.GOOGLE_CLIENT_ID);
  }
}

type CoreEnv = { CHARTER_CORE?: DurableObjectNamespace<CharterCore>; GOOGLE_CLIENT_ID: string };

/** A fetch that targets the container when the binding exists, else the global fetch. */
export async function coreFetch(env: CoreEnv): Promise<typeof fetch> {
  const ns = env.CHARTER_CORE;
  if (!ns) return fetch;
  const name = await instanceName(coreEnv(env as unknown as Record<string, unknown>, env.GOOGLE_CLIENT_ID));
  const stub = ns.getByName(name);
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    stub.fetch(new Request(input, init))) as typeof fetch;
}
```
(`import type` keeps the circular import compile-safe. If `tsc` rejects `getByName` on `DurableObjectNamespace`, bump `@cloudflare/workers-types` to latest; it is present in 4.2026xxxx builds. `max_instances: 2` in Task 7 allows the old and new instance to overlap during rotation.)

`index.ts` changes:
- Add `export { CharterCore } from "./container";` (the DO class must be exported from `main`) and `import { coreFetch, CORE_URL } from "./container";`.
- `Env`: add `CHARTER_CORE?: DurableObjectNamespace<import("./container").CharterCore>;` and change `CHARTER_CORE_URL: string` to `CHARTER_CORE_URL?: string`. `missingConfig` (147-159) does not list `CHARTER_CORE_URL` today; leave it alone.
- `coreConfig(env)`: `url: env.CHARTER_CORE ? CORE_URL : (env.CHARTER_CORE_URL ?? "")`.
- Both call sites: `const f = await coreFetch(env);` then pass `f` where `fetch` was passed (`buildServer` is already async-capable — if it is synchronous, compute `f` once at the top of `buildServer`'s caller `apiHandler` (318-357) and pass it in; keep `buildServer`'s signature change minimal).

`gateway/test/container.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { coreEnv, coreFetch, instanceName, CORE_URL } from "../src/container";

describe("coreEnv", () => {
  it("strips CORE_ and adds the fixed trio, ignoring bindings and other vars", () => {
    const env = { CORE_CHARTER_KEYS: "{}", CORE_PACKS: "charter", GOOGLE_CLIENT_SECRET: "s", OAUTH_KV: {} };
    expect(coreEnv(env, "cid")).toEqual({
      CHARTER_KEYS: "{}", PACKS: "charter", PORT: "8080", CHARTER_BACKEND: "cloudflare", GOOGLE_OAUTH_CLIENT_ID: "cid",
    });
  });
});

describe("instanceName", () => {
  it("is stable across key order and changes with any value", async () => {
    const a = await instanceName({ A: "1", B: "2" });
    expect(await instanceName({ B: "2", A: "1" })).toBe(a);
    expect(await instanceName({ A: "1", B: "3" })).not.toBe(a);
    expect(a).toMatch(/^core-[0-9a-f]{16}$/);
  });
});

describe("coreFetch", () => {
  it("returns global fetch when no binding", async () => {
    expect(await coreFetch({ GOOGLE_CLIENT_ID: "cid" })).toBe(fetch);
  });
  it("routes to the env-named instance and forwards method, path, headers, body", async () => {
    let seen: Request | undefined; const names: string[] = [];
    const ns = { getByName: (n: string) => { names.push(n); return { fetch: async (r: Request) => { seen = r; return new Response("ok"); } }; } } as any;
    const f = await coreFetch({ CHARTER_CORE: ns, GOOGLE_CLIENT_ID: "cid", CORE_X: "1" } as any);
    const res = await f(CORE_URL, { method: "POST", headers: { "X-API-Key": "k" }, body: "{}" });
    expect(await res.text()).toBe("ok");
    expect(names[0]).toMatch(/^core-[0-9a-f]{16}$/);
    expect(seen!.method).toBe("POST");
    expect(new URL(seen!.url).pathname).toBe("/");
    expect(seen!.headers.get("X-API-Key")).toBe("k");
    expect(await seen!.text()).toBe("{}");
  });
});
```
The `CharterCore` class body is exercised only by the live smoke (Task 9).

**Verify:** `cd gateway && npm run typecheck && npx vitest run test/container.test.ts test/core.test.ts`

## Task 6 — gateway: `POST /call` headless passthrough  (`sonnet`)

**Exists because:** n8n/cron callers hit the core's public URL today; a container has no public URL, so the gateway must forward API-key calls.
**Files:** `gateway/src/index.ts` (`authHandler.fetch`, the `defaultHandler`, ~449-882), `gateway/test/call.test.ts` (new).
**Follows:** route order in `authHandler.fetch`: insert the `/call` branch just **before** the `if (url.pathname === "/") {` check at line ~875. `TRACEPARENT` regex is exported from `core.ts:186` (export it if it is not). Test harness copied from `gateway/test/index.wiring.test.ts:15-49`.

Add to `authHandler.fetch`:
```ts
if (url.pathname === "/call" && env.CHARTER_CORE) {
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const key = request.headers.get("X-API-Key");
  if (!key) return json({ ok: false, error: "unauthorized" }, 401);
  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > 1_048_576) return json({ ok: false, error: "too_large" }, 413);
  const headers: Record<string, string> = { "Content-Type": "application/json", "X-API-Key": key };
  const tp = request.headers.get("traceparent");
  if (tp && TRACEPARENT.test(tp)) headers["traceparent"] = tp;
  try {
    const f = await coreFetch(env);
    const res = await f(CORE_URL, { method: "POST", headers, body: await request.text() });
    return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("core unavailable", (e as Error).message);
    return json({ ok: false, error: "core_unavailable" }, 502);
  }
}
```
Only `X-API-Key` and `traceparent` are forwarded — never `X-Actor-Token` (`docs/remote-mcp.md` §4.1: no key alongside an actor token). Without the binding the path falls through to the existing 404.

`gateway/test/call.test.ts`:
```ts
import { env as testEnv } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index.js";

const ORIGIN = "https://charter-gateway.example.com";   // = wrangler.test.jsonc CHARTER_GATEWAY_URL

function fakeCore() {
  const seen: Request[] = [];
  const ns = { getByName: () => ({ fetch: async (r: Request) => { seen.push(r); return new Response('{"ok":true}', { status: 200 }); } }) };
  return { ns: ns as unknown as Env["CHARTER_CORE"], seen };
}
function envWith(overrides: Partial<Env>): Env {
  return { ...(testEnv as Env), GOOGLE_CLIENT_ID: "test-google-client", GOOGLE_CLIENT_SECRET: "s",
           OAUTH_STATE_SECRET: "test-state-secret-0123456789", ...overrides };
}
async function call(env: Env, init: RequestInit, path = "/call"): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init) as any, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("POST /call", () => {
  it("401 without a key and never touches core", async () => {
    const { ns, seen } = fakeCore();
    const res = await call(envWith({ CHARTER_CORE: ns }), { method: "POST", body: "{}" });
    expect(res.status).toBe(401); expect(seen).toHaveLength(0);
  });
  it("forwards key, body and traceparent; never an actor token", async () => {
    const { ns, seen } = fakeCore();
    const res = await call(envWith({ CHARTER_CORE: ns }), { method: "POST", body: '{"verb":"verbs.list"}',
      headers: { "X-API-Key": "k1", "X-Actor-Token": "evil", traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" } });
    expect(res.status).toBe(200); expect(await res.text()).toBe('{"ok":true}');
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.get("X-API-Key")).toBe("k1");
    expect(seen[0].headers.get("X-Actor-Token")).toBeNull();
    expect(seen[0].headers.get("traceparent")).toContain("0af7651916cd43dd");
    expect(await seen[0].text()).toBe('{"verb":"verbs.list"}');
  });
  it("405 on GET, 413 over 1 MiB, 502 when core throws", async () => {
    const { ns } = fakeCore();
    expect((await call(envWith({ CHARTER_CORE: ns }), { method: "GET" })).status).toBe(405);
    expect((await call(envWith({ CHARTER_CORE: ns }), { method: "POST", body: "{}", headers: { "X-API-Key": "k", "content-length": "2000000" } })).status).toBe(413);
    const boom = { getByName: () => ({ fetch: async () => { throw new Error("no container"); } }) } as unknown as Env["CHARTER_CORE"];
    expect((await call(envWith({ CHARTER_CORE: boom }), { method: "POST", body: "{}", headers: { "X-API-Key": "k" } })).status).toBe(502);
  });
  it("404 without the binding (GCP mode unchanged)", async () => {
    expect((await call(envWith({ CHARTER_CORE: undefined }), { method: "POST", body: "{}", headers: { "X-API-Key": "k" } })).status).toBe(404);
  });
});
```
(If the pool rejects a hand-set `content-length` header, send a real 1.1 MB body for the 413 case instead.)

**Verify:** `cd gateway && npx vitest run test/call.test.ts test/index.wiring.test.ts`

## Task 7 — wrangler config, Dockerfile, test config  (`sonnet`)

**Exists because:** `wrangler deploy` needs the `containers` + DO + migration blocks, and the vitest pool must not see them.
**Files:** `gateway/wrangler.jsonc`, `gateway/wrangler.test.jsonc` (new), `gateway/vitest.config.ts`, `Dockerfile`, `.dockerignore` (new, repo root).
**Follows:** current `gateway/wrangler.jsonc` (46 lines; keep the `global_fetch_strictly_public` flag and its comment).

`gateway/wrangler.jsonc` additions (keep everything that is there; above `CHARTER_CORE_URL` in `vars` add the comment `// GCP-origin deployments only; ignored when the CHARTER_CORE binding exists`):
```jsonc
"containers": [{
  "class_name": "CharterCore",
  "image": "../Dockerfile",
  "image_build_context": "..",
  "instance_type": "basic",
  "max_instances": 2          // old + new instance overlap for ≤ sleepAfter after a secret change
}],
"durable_objects": { "bindings": [{ "name": "CHARTER_CORE", "class_name": "CharterCore" }] },
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["CharterCore"] }],
"observability": { "enabled": true }
```
`gateway/wrangler.test.jsonc`: copy `wrangler.jsonc` after the edit, delete the `containers`, `durable_objects`, `migrations` blocks, and put this comment at the top: `// Test-only twin of wrangler.jsonc: no containers (the vitest pool cannot build images). Keep vars/kv_namespaces identical; index.wiring.test.ts ORIGIN must equal CHARTER_GATEWAY_URL here.` `vitest.config.ts`: `configPath: "./wrangler.test.jsonc"`. `gateway/wrangler.staging.jsonc` is git-ignored and RC-specific: do not touch it (it stays a GCP-origin gateway).

`Dockerfile` (root): add `ENV PORT=8080` and `EXPOSE 8080` before `CMD`. Wrangler builds the image for linux/amd64 itself; no buildx step on an arm64 Mac.
`.dockerignore` (root): `gateway/`, `.venv/`, `tests/`, `docs/`, `.git/`, `**/node_modules`, `**/__pycache__`, `charter-keys.json`, `charter-grants.json`.

**Verify:** `cd gateway && npm run typecheck && npm test` (every existing suite green under the test config), then `npx wrangler deploy --dry-run --outdir /tmp/charter-dry`. Expected: config accepted. **Assumption to check:** a dry run should not need an account or Docker; if it tries to build the image, start Docker Desktop and rerun; if it rejects `containers`/`instance_type`, bump `wrangler` to 4.149.0 and `@cloudflare/vitest-pool-workers` to its newest in one commit and rerun both commands.

## Task 8 — docs: Cloudflare-only install path  (`sonnet`)

**Exists because:** the design's deliverable is "a stranger deploys charter with one Cloudflare account"; without the runbook the code is unreachable.
**Files:** `docs/deployment/cloudflare.md` (new), `docs/INSTALL.md`, `docs/deployment/gateway.md`, `docs/configuration.md`, `README.md` (one paragraph), `docs/remote-mcp.md` (three passages + table).
**Follows:** tone/structure of `docs/deployment/gcp-cloud-run.md` and `docs/deployment/gateway.md` §4 (lines 65-185 — read them; the vars/secrets lists there are what step 6 below copies); project-owner writing rule: Simplified Technical English, real filled-in examples, no "the tool never".

`docs/deployment/cloudflare.md`, in this order, with exact commands:
1. Prereqs: Cloudflare account on Workers Paid ($5/mo; Containers need it), Docker running locally, Node 20+, `npx wrangler login`.
2. Google Web OAuth client (link to `gateway.md` step 1).
3. `cd gateway && npm ci`; `npx wrangler kv namespace create OAUTH_KV` → paste id into `wrangler.jsonc`; `npx wrangler d1 create charter-audit` → note the `database_id`; `npx wrangler d1 execute charter-audit --remote --file ../sql/audit_table.d1.sql`.
4. API token for D1: dashboard → My Profile → API Tokens → Create Custom Token, permission **Account · D1 · Edit**, scoped to this account. `npx wrangler secret put CORE_CF_API_TOKEN`. Vars in `wrangler.jsonc`: `CORE_CF_ACCOUNT_ID` (from the dashboard URL), `CORE_CF_D1_DATABASE_ID` (from step 3). Note: this token can also delete from the table; the audit log is tamper-evident only as far as the token is protected (BigQuery's insert-only path had no delete). Optionally export the table on a schedule.
5. Keys: `CHARTER_BACKEND=cloudflare charter keys add --name first-agent --allow "verbs.*,identity.*"` (nothing else is needed; the CLI reads only that variable in this mode) → `npx wrangler secret put CORE_CHARTER_KEYS < charter-keys.json`. Grants: create `charter-grants.json` with exactly `{"you@example.com": {"allow": ["verbs.*", "identity.*"]}}` (shape per `grants.md`) → `npx wrangler secret put CORE_CHARTER_GRANTS < charter-grants.json`. Both files are git-ignored.
6. Gateway config: list every var and secret from `gateway.md` §4 **except** `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `CHARTER_CORE_URL` (those are for a GCP origin). Then the core's env, each as `CORE_<name>`: vars `CORE_ALLOWED_DOMAIN` (same value as `CHARTER_ALLOWED_DOMAIN` — core and gateway each read their own), `CORE_CHARTER_GATEWAY_URL` (same value as `CHARTER_GATEWAY_URL`), `CORE_PACKS=charter`; secrets `CORE_CHARTER_KEYS`, `CORE_CHARTER_GRANTS`, `CORE_CF_API_TOKEN`. Any pack setting from `configuration.md` "Pack-specific" goes in as `CORE_<NAME>` too.
7. `npx wrangler deploy` — builds and pushes the image. After the first deploy wait a few minutes before the first call.
8. Smoke: `curl -s -X POST https://<gateway>/call -H 'X-API-Key: <key>' -H 'Content-Type: application/json' -d '{"verb":"verbs.list"}'` → `ok: true`; `npx wrangler d1 execute charter-audit --remote --command "select ts, actor, verb, result from audit order by ts desc limit 3"` shows the row.
9. Rotating a secret: `npx wrangler secret put CORE_…` → the next request starts a fresh container with the new env (1–3 s); the old key is refused from that request on. Cold start after 10 min idle: 1–3 s. `AUDIT_TABLE` is not used in cloudflare mode; the D1 table is always `audit`. Protect `/call`: add a WAF rate-limiting rule (Security → WAF → Rate limiting rules, e.g. 60 requests/min per IP on path `/call`) — the gateway cannot tell a valid key from junk, and junk wakes and bills the container.
10. What stays on GCP: nothing for the engine; `results.py` offload stays off (results are inline). The reference `bigquery`/`gdrive` packs read Secret Manager / ADC (`gdrive_upload.py:35-41`, `warehouse_query.py:43-54`) and are **GCP-mode only**.

Other files:
- `INSTALL.md`: Prerequisites → "Python 3.10–3.12 and EITHER a Cloudflare account (`deployment/cloudflare.md`) OR a GCP project (`deployment/gcp-cloud-run.md`)"; Step 3 shows `CHARTER_BACKEND`; Step 4's Secret Manager paragraph gets a sibling "Cloudflare: `charter-keys.json` + `wrangler secret put`".
- `gateway.md` §4: one note at the top: `CF_ACCESS_*` and `CHARTER_CORE_URL` apply to a GCP origin only; for Containers see `cloudflare.md`.
- `remote-mcp.md`: at `:79-80`, `:607-611`, and `:727` add the same sentence: "In the Cloudflare Containers deployment the Durable Object is only the container's lifecycle handle; it stores nothing, and a changed secret starts a new instance under a new name." In the comparison table (near `:79`), the gateway "Holds" row gains: "in the Containers deployment, also core's `CORE_*` secrets (same deploy); a gateway-side leak exposes them — accepted trade-off for a single-account deploy." "Writes audit: never" stays true.
- `README.md`: one line: "Deploys on Cloudflare alone (Workers + Containers + D1) or on GCP Cloud Run."

**Verify:** `grep -c "CORE_CHARTER_KEYS" docs/deployment/cloudflare.md` ≥ 1; `grep -c "lifecycle handle" docs/remote-mcp.md` = 3; every env var named in `cloudflare.md` exists in `settings.py` or `container.ts` (reviewer check).

## Task 9 — live smoke on a real Cloudflare account  (operator + `sonnet`)

**Exists because:** the Container class, image build, D1 token scope, rotation-by-name, and the long-request question (`t_dm37x2vo9wo02`) can only be proven live.
**Files:** `src/charter/packs/smoke/__init__.py` (new, ~12 lines: one verb `smoke.sleep {seconds≤600}` that `time.sleep`s and returns `{"slept": n}`, registered the same way as `src/charter/packs/bigquery/__init__.py`), `pyproject.toml` entry point `smoke = "charter.packs.smoke"`, `tests/test_smoke_pack.py` (loads it via the SDK loader with `PACKS=smoke` and calls it with `seconds=0`).
**Steps (needs Jason's `wrangler login` and Docker Desktop running; the agent prepares each command, the human runs or approves it):**
1. Follow `docs/deployment/cloudflare.md` with Worker name `charter-gateway-smoke` and `CORE_PACKS=charter,smoke`.
2. `/call` → `verbs.list` returns `ok: true`; D1 shows the audit row with `actor` = key name.
3. Rotation: add a second key with `charter keys add`, `wrangler secret put CORE_CHARTER_KEYS`, then: new key → 200; **old key (revoked with `charter keys revoke`) → 401** on the very next call. Also fire 5 concurrent `/call`s during the switch and confirm all return 200 or 401, never 5xx.
4. Duration: `curl --max-time 300 … -d '{"verb":"smoke.sleep","seconds":150}'` → `{"slept":150}`. functions-framework runs gunicorn with `--timeout 0`, so the only cap is Cloudflare's; record the measured ceiling on todo `t_dm37x2vo9wo02` and in `cloudflare.md` ("long verbs: verified N s").
5. Tear down: `npx wrangler delete --name charter-gateway-smoke`, `npx wrangler d1 delete charter-audit-smoke`, revoke the API token in the dashboard.

**Verify:** the facts from steps 2–4 in the PR description with command outputs.

## Out of scope (phase 2, rc-data-tools)
RC pack cutover (Firestore → D1, pack secrets → `CORE_*`, BigQuery data verbs via SA key), rc-dashboards/n8n repointing, deleting Cloud Run/tunnel/Access/WIF. The reference `bigquery`/`gdrive` packs stay GCP-mode only.
