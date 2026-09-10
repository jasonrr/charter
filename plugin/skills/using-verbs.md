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
- `unauthorized` — your signed-in email has no grant — the deployment operator must add you (see docs/deployment/grants.md)
- `improve_disabled` — this deployment has not configured `improve.report`; tell the user what you would have filed

## Large Payloads

- Large **inputs** go by reference: pass an id or URI the verb dereferences
  (a Drive file id, a table name) — never paste a large body into args.
- Large **results** come back as a `resource_link` (`charter://result/<id>`)
  instead of inline JSON. Read the linked resource only if the inline summary
  is not enough — it is the full body. Links expire and are readable only by
  the caller that produced them; if one is gone, re-run the verb.

## Reporting a gap

Charter gets better from use. When any of these happen during a task, file it:

- a verb returned an error you had to work around
- a verb you needed does not exist, or exists but is `denied` to you
- you could not finish the task with the verbs available

Call `improve.report` with `kind: "gap"`. `title` is one line; `body` says what
you were trying to do, what happened, and what would have fixed it; `context`
carries `verb`, `error_code`, `request_id` (from the failing response), and
`workaround` if you found one. It files a GitHub issue and returns its URL —
tell the user the issue number. It is callable by every authenticated caller,
even one with no other scope.

Ask the user before filing only if the report would include their data. A
failing response may carry a `hint` field reminding you of this.

## Creating and sharing a skill

When a user asks for a skill, draft it with them as a normal `SKILL.md`
(a short H1, when to use it, the verbs it calls in order, what to confirm
with the user). When they want the team to have it, call `improve.report`
with `kind: "skill"`, `title` = the skill name, `body` = why it exists, and
`proposal` = the full markdown. A maintainer reviews it and ships it in the
next plugin version; tell the user the issue number so they can follow it.
