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

## cloudflare-core (PR #7, 2026-10-12)

- Plan's setup line `python3 -m venv .venv` → on this Mac `python3` is 3.14 and the package pins `<3.13`, so `pip install -e` fails and no pytest exists. Setup commands must name the interpreter (`python3.11 -m venv .venv`).
- Plan assumed `wrangler deploy --dry-run` needs no Docker → it builds the container image even in dry-run and fails without a running daemon. `--containers-rollout=none` validates the rest of the config without Docker; the image build itself only gets proven with Docker up.
- Plan's `/call` size guard checked only `content-length` → a chunked body has none, and the first fix (`arrayBuffer()` then check) still buffered the whole body before rejecting it. A body cap at a trust boundary must be a streaming cap that cancels the read.
- Plan's rotation design read the container env from the Durable Object's own `env` → during a deploy the Worker and the DO can run different versions, so a new-named DO could start a container with the old secrets and keep them for its life. Any state a Worker hashes into a DO name must be passed to the DO by that Worker, not re-read from the DO's env.
- Plan promised "old key 401 on the very next call" after `wrangler secret put` → Cloudflare rolls a secret change out over ~30 s, and old and new versions serve side by side meanwhile. A plan must not promise instant revocation on a platform with gradual rollout; state the measured window.
- The containers library answers an instance-cap hit with `500 text/plain`, not a throw → a gateway that only catches exceptions passes the platform's text through. Classify a non-JSON 5xx from the container as "core unavailable".
- `wrangler delete` leaves the container application and its image behind, and `CLOUDFLARE_API_TOKEN` in the shell silently overrides `wrangler login` (it needed Containers · Edit, and the account needed Workers Paid). Live smokes need a teardown that lists what remains.
- The operator twice put the wrong thing on the clipboard (a token ID, then nothing usable) → check a pasted credential with a harmless API call before a deploy depends on it.
- Plan made one `wrangler.jsonc` serve both deployment shapes and let a present binding beat an explicit URL → every GCP-origin adopter following the old gateway doc would silently deploy a container. When a config file gains a mode-switching block, the other mode's doc must say to remove it.
- Plan's runbook example `CORE_PACKS=charter` (the default) loads every pack in the `charter` distribution, including the GCP-only ones → in the new backend those verbs register and fail at call time with outbound credential attempts. A new backend needs its own pack default checked, not the old one inherited.
- A CLI whose state file defaults to a cwd-relative path, and whose next step pushes that file over the live secret, turns "ran it from the wrong directory" into "revoked every key". A missing state file must be an error for every command but the one that creates it.
