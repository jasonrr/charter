# Improving from use

Charter's verbs and skills are supposed to be shaped by what people actually
try to do, not only by whoever wrote the pack. `improve.report` is the
mechanism: an agent that hits a gap, or a user with a skill to share, files it
as a GitHub issue from any Claude surface, and the fix lands through an
ordinary PR.

## What gets filed

- `kind: "gap"` — a verb failed and was worked around, a needed verb was
  missing or `denied`, or a task could not be finished.
- `kind: "skill"` — a SKILL.md a user drafted and wants the team to have.

The verb is callable by every authenticated caller regardless of scope: a
`denied` is exactly the thing it exists to report. It still honours a key's
`require_actor`, so every issue names a person.

## Enabling it

Set `IMPROVE_GITHUB_REPO` and `IMPROVE_GITHUB_TOKEN` (see
`configuration.md`). The token is a fine-grained PAT with Issues read/write on
that one repo and nothing else. Create the labels `gap` and `skill` in the
repo. Unset either value and the verb answers `improve_disabled`.

When enabled, `denied`, `unknown_verb`, and handler-error responses carry a
one-line `hint` pointing at the verb.

## Why it lives in the engine

Charter keeps provider code in packs. This verb talks to GitHub from the
engine anyway, on purpose: it reports on the engine's own verb surface and has
to exist in every deployment whatever packs are loaded; the host is one config
value, not an integration (no OAuth, no per-user credential, nothing flows from
GitHub into verbs); and unset disables it.

## The issue

Fixed headings so the body is machine-readable: Reporter, Kind,
Context (gap: verb, error_code, request_id, workaround), Proposal
(skill: fenced markdown), Report. The `request_id` joins the issue to the audit row. The issue
is the durable record; charter's own audit row for the call carries `issue:N`
as its target once the issue exists.

## Closing the loop

The plugin's `improve` skill walks a maintainer through open `gap`/`skill`
issues and into the normal dev loop; PRs say `fixes #N`. The intended next
step is an agent that watches these issues and opens the PRs itself, with a
human still merging. The issue shape above is designed for that reader.

## What is deliberately not here

No table, no list/resolve verbs, no auto-filing of every error, no dedupe at
report time, no rate limit. Each has a stated add-back trigger in the design
record; the first version optimises for the report being visible.
