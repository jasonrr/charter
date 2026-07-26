# Pack Authoring Guide

A **pack** is a Python module that registers verbs with the charter engine.
Packs are the primary extension mechanism — you write one for your stack,
register it, and the engine dispatches to it.

## The Five SDK Primitives

From `charter.sdk`:

1. **`register(verb, handler, audit_policy, read=False, dry_run=False)`**
   - `verb`: dot-notation name (e.g. `myapp.invoice.create`)
   - `handler`: plain (synchronous) function `fn(body, caller)` returning a dict
   - `audit_policy`: `"pre"` (irreversible, write attempt row) or `"post"` (read, no attempt row)
   - `read`: `True` for read verbs, `False` for write verbs
   - `dry_run`: `True` if the handler supports `body.get("dry_run")` preview mode

2. **`register_prefix(prefix, handler, catalog=None)`**
   - Registers a prefix family (e.g. `data.warehouse.`). The handler has the
     same `fn(body, caller)` signature and reads the full verb name from
     `body["verb"]` to decide which leaf to serve.

3. **`VerbError(status, code, detail=None)`**
   - The only exception type handlers should raise. `code` is machine-matchable
     (e.g. `denied`, `confirm_required`, `bad_deal_id`).

4. **`identity_context()` / `identity_context(actor_id, is_human)`**
   - Access the current request's actor identity. Returns `(actor_id, is_human)`
     or `None` if no actor is authenticated.

5. **`get_config()`**
   - Access pack-specific configuration. Not engine env vars — pack-internal
     settings like HubSpot portal IDs, Airtable base names, etc.

## Naming Security Boundary

The engine enforces a strict naming convention:

- **Read verbs** MUST end in a read-word: `.query`, `.read`, `.list`, `.schema`,
  `.status`, `.views`, `.whoami`
- **Write verbs** MUST NOT end in a read-word
- Violations raise `VerbError(400, "naming_violation")` at registration time

This prevents a malicious or buggy pack from disguising a write as a read.

## Handler Result Conventions

Handlers return a dict. The engine wraps it with `ok: true` and adds
`request_id` (U3). Common patterns:

- **Read verbs**: return `{ "rows": [...], "target": "..." }` or `{ "views": {...} }`
- **Write verbs (dry_run)**: return `{ "plan": {...}, "target": "...", "dry_run": true }`
- **Write verbs (confirm)**: return `{ "sent": [...], "skipped": [...], "target": "..." }`
- **Errors**: raise `VerbError(status, code, detail)` — never raw exceptions

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
- `result_ref` is a reserved top-level key in success results. Don't return
  your own `result_ref` field — the gateway treats that shape as an offload
  envelope and will hide the real body behind a resource link.

## The dry_run Convention

Irreversible verbs should support `dry_run`:

1. Declare `dry_run=True` at registration
2. In the handler, check `body.get("dry_run")`
3. If true, compute and return the plan with NO side effects and NO attempt row
4. If false, require `confirm: true` and execute

The dispatcher skips the pre-audit attempt row ONLY when both conditions hold:
the verb declared `dry_run=True` AND the caller passed `dry_run: true`.

## Conformance Loop

Run the conformance suite after writing your pack:

```bash
charter-packtest --pack my.pack.module --json
```

Or in pytest:

```python
from charter.packtest.checks import evaluate_pack
import my.pack.module

results = evaluate_pack(my.pack.module)
failures = [r for r in results if r.level == "failure"]
assert not failures
```

The suite checks:
- Naming security boundary
- Docstring presence (becomes catalog summary)
- `VerbError` usage (no raw exceptions)
- Audit policy correctness (pre for writes, post for reads)
- `dry_run` declaration for irreversible verbs
- Response size budget (1 MB cap)

## Pack Trust Model

**Packs run in-process with full engine trust and credential access.** The
conformance suite checks contract compliance, not behavior. A malicious pack
can exfiltrate data or corrupt your systems. **Review any agent-authored or
third-party pack before listing it in `settings.packs`.** The engine's
permission model governs *which caller can call which verb* — it does not
sandbox the handler's implementation.

## Example: Minimal Pack

```python
# mypack/__init__.py
from charter.sdk import register, VerbError

def hello(body, caller):
    """Say hello to the caller."""
    return {"message": f"Hello, {body.get('name', 'world')}!"}

register("myapp.hello", hello, "post", read=True)
```

```python
# mypack/__init__.py (for entry-point discovery)
name = "mypack"  # must match the entry-point name in pyproject.toml
```

```toml
# pyproject.toml
[project.entry-points."charter.packs"]
mypack = "mypack"
```
