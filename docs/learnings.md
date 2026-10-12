# Learnings

## improve-report (PR #4, 2026-09-10)

- Plan transcribed a full test file but not the `@lru_cache` on `get_settings()` → a helper that only sets env vars leaves stale settings, and any test that toggles config mid-test silently tests the wrong thing. Plans that hand a test file env vars must hand it the cache_clear too.
- Plan's "Files" list omitted a test that hardcodes the value being changed (`tests/test_bridge.py` asserts the literal `_ALWAYS_ALLOWED` set) → the implementer hit its file-scope stop condition and the task needed a round trip. When a task widens a registry or constant, grep for tests asserting that constant and list them.
- Repo has no `dev_scripts/setup-worktree.sh`, so a fresh worktree has no `.venv` and the plan's verify command cannot run until one is built by hand.
- Plan prose containing a shell command was transcribed into a skill unverified: `gh issue list --label a --label b` ANDs labels, so the triage skill's first step could never return a result. A command a human will paste needs its semantics checked at plan time, not just its spelling.
- Plan prose asserted what a constant's text says ("a `hint` field reminding you of this") without matching it against the constant it defined three sections earlier. When a plan fixes a literal string, later prose about that string must quote it.
- The plan fixed an issue-body template whose section order could not carry the property the design needed: free-form caller text was emitted before machine-read metadata, so a caller could forge an earlier copy of any heading that followed it. A template whose headings are a contract must put every caller-controlled section last, and the plan should say why the order is what it is.
- A size guard written as `len(s.encode())` is not total: a lone surrogate from JSON raises and turns bad input into a 500. Any encode on caller text needs an errors= policy.
- A skill that has an agent read and act on user-submitted text is a prompt-injection surface, and neither the design nor the plan named it. Worth a standing check whenever a skill consumes data a verb wrote.
- Reviewing the fix for a finding caught that the fix's own claim was false for one heading. The scoped re-review after a fix round earns its cost; a fix that documents a new invariant needs that invariant tested, not just asserted in a comment.

## cloudflare-core (PR #pending, 2026-10-12)

- Plan's setup line `python3 -m venv .venv` → on this Mac `python3` is 3.14 and the package pins `<3.13`, so `pip install -e` fails and no pytest exists. Setup commands must name the interpreter (`python3.11 -m venv .venv`).
- Plan assumed `wrangler deploy --dry-run` needs no Docker → it builds the container image even in dry-run and fails without a running daemon. `--containers-rollout=none` validates the rest of the config without Docker; the image build itself only gets proven with Docker up.
- Plan's `/call` size guard checked only `content-length` → a chunked body has none, and the first fix (`arrayBuffer()` then check) still buffered the whole body before rejecting it. A body cap at a trust boundary must be a streaming cap that cancels the read.
