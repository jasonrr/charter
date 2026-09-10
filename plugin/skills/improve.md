# Triaging improvement reports

For maintainers. Run this in Claude Code inside the repo that receives
`improve.report` issues (the repo named by `IMPROVE_GITHUB_REPO`).

## Read

`gh issue list --label gap --label skill --state open --json number,title,labels,body`

Each issue body has fixed headings: Reporter, Kind, Report, Context (gap only:
verb, error_code, request_id, workaround), Proposal (skill only, fenced
markdown). Show the user a numbered list: number, kind, title, reporter, and a
one-line summary of the Report.

## Decide, one at a time

For each item the user accepts:

- **gap** → start the repo's normal dev loop on it (brainstorm if the fix is
  not obvious, otherwise plan/build). The PR description must include
  `fixes #<number>` so merging closes the issue. If the gap belongs to a
  different repo (an engine bug reported against a pack repo, or the reverse),
  say so and open the issue there instead, then close this one with a comment
  linking it.
- **skill** → copy the Proposal block into the plugin's skills directory as a
  new file, read it as a reviewer would (does it name real verbs? does it
  confirm before writes?), bump the plugin version, open a PR with
  `fixes #<number>`.

For each item the user declines: `gh issue close <number> --comment "<one line why>"`.

Duplicates get `gh issue edit <number> --add-label duplicate` and a comment
naming the original; do not close the original.

## Stop

Do not fix anything the user did not accept. Do not merge.
