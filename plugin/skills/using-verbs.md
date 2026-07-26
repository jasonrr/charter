# Using Charter Verbs

How to interact with a charter deployment through its gateway (remote MCP).

## Discovery

Always start with `verbs.list`. It returns every verb your key or grant can call, with a one-line summary and read/write flag. It's always callable even with an empty scope.

## Read vs Write

- **Read verbs** (`data.warehouse.query`, `data.warehouse.schema`) are safe to call freely. They return data, never modify it.
- **Write verbs** (`airtable.batch_update`) require `confirm:true` for irreversible actions. Call with `dry_run:true` first to preview what would happen.

## The dry_run Pattern

For any irreversible verb:

1. Call with `dry_run: true` → get a plan with no side effects
2. Review the plan
3. Call again with `confirm: true` → execute and audit

If a verb doesn't declare `dry_run` support, the pre-audit attempt row is still written (fail-closed).

## Error Codes

Match on the `error` field:

- `denied` — your key or grant lacks scope for this verb
- `actor_required` — reconnect the MCP server to trigger the gateway's OAuth sign-in flow
- `confirm_required` — pass `confirm:true` for this irreversible verb
- `bad_deal_id` / `naming_violation` — malformed input
- `write_in_read_tool` — you sent a write verb through `charter_read` (use `charter_call` instead)
- `no_grant` / `unauthorized` — your signed-in email has no grant — the deployment operator must add you (see docs/deployment/grants.md)

## Large Payloads

- `args_path` — read request body from a local JSON file (for bulk updates)
- `out_path` — write response to a local file, get a summary back (for large query results)
