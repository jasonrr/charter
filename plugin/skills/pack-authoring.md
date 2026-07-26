# Pack Authoring Skill

Teach an AI coding agent to write a new charter pack.

## Workflow

1. **Read the SDK** — `src/charter/sdk/__init__.py` has five primitives:
   - `register(verb, handler, audit_policy, read, dry_run)`
   - `register_prefix(prefix, handler, catalog)`
   - `VerbError(status, code, detail)`
   - `identity_context()` / `identity_context(actor_id, is_human)`
   - `get_config()`

2. **Pick a reference pack** — `src/charter/packs/airtable/` or `src/charter/packs/bigquery/`. Copy its structure:
   - `__init__.py` with `register` / `register_prefix` calls at module top
   - Handler modules with docstrings (become the catalog summary)
   - `name` attribute on the package for entry-point discovery

3. **Name your verbs** — follow the `domain.leaf` convention:
   - Read verbs end in a read-word: `.query`, `.read`, `.list`, `.schema`, `.status`, `.views`
   - Write verbs end in anything else: `.update`, `.create`, `.send`, `.publish`
   - The engine enforces this; wrong names = `VerbError(400, "naming_violation")`

4. **Declare intent**:
   - `read=True` for read verbs (post-audit, no confirm gate)
   - `read=False` for write verbs (pre-audit + confirm gate)
   - `dry_run=True` for irreversible verbs that support preview (the handler checks `body.get("dry_run")`)

5. **Handle errors with VerbError** — never raise raw exceptions. Every error gets a machine-matchable code.
   - Large inputs by reference (id/URI, dereferenced in the handler); large outputs return automatically as a `result_ref` — never build per-verb blob handling.

6. **Run conformance** — `charter-packtest --pack your.pack.module --json` or import `charter.packtest.checks.evaluate_pack` in a pytest.

7. **Fix, iterate, ship** — the conformance suite is your agent's test-driven development loop.
