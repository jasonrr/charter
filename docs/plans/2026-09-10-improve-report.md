# Plan: improve-report — usage-driven self-improvement loop (v1)

- **Goal:** one always-callable engine verb `improve.report` that files a GitHub issue (kind `gap` or `skill`), a `hint` on failing responses pointing at it, plugin skill text so agents use it, a maintainer skill to triage, and docs. Charter OSS only.
- **Design:** tally scratchpad `s_dlbo6b4wg9a81` (approved 2026-09-10). Read it first.
- **Branch:** `feat/improve-report`
- **Whole-feature verify:** `.venv/bin/python -m pytest -q` (all green; `tests/test_packtest.py` covers the shared registry, so the new built-in is conformance-checked there).
- **Repo rules:** fail closed on unset config, errors are `VerbError(status, code, detail)` and details never echo secrets, `ponytail:` comments name the ceiling. Reviewer lenses: `.claude/tally-dev-loop.md`.
- **Decisions already made (do not relitigate in build or review):**
  - *Engine-level GitHub call is a deliberate exception to "provider code lives in packs".* Recorded here so review-branch treats it as decided. Why: the verb reports on the engine's own verb surface and must exist in every deployment regardless of which packs are loaded; the host is one config value, not an integration (no OAuth, no per-user credential, no data flowing from GitHub into verbs); unset disables it. A pack could not be scope-exempt or hook the error envelope without the engine knowing its name anyway.
  - *Audit policy is `post`, no `target_field`.* A `pre` row keyed on a caller-supplied title would durably store unbounded text before validation, even when the verb is disabled (`_bounded_verb` exists to prevent exactly that). The GitHub issue is itself the durable record; the ok row carries `issue:N`.
  - *Scope-exempt, not actor-exempt.* See the `_ALWAYS_ALLOWED` comment in T1.
- **Ordering:** T1 → T2 (T2 imports `improve.enabled`). T3, T4 depend on T1 only for the verb name and response shape (fixed below), so they can run after T1 in parallel with T2.

## Fixed interfaces (every task transcribes these; do not improvise)

Request body for `improve.report`:
```json
{"verb": "improve.report", "kind": "gap|skill", "title": "str", "body": "str",
 "context": {"verb": "str?", "error_code": "str?", "request_id": "str?", "workaround": "str?"},
 "proposal": "str? (required when kind=skill: the SKILL.md text)"}
```
Success: `{"ok": true, "verb": "improve.report", "request_id": "...", "issue": "<html_url>", "number": 123, "target": "issue:123"}`
Errors (all `VerbError`): `improve_disabled` 503, `bad_kind` 400, `missing_field` 400, `bad_proposal` 400, `too_large` 413, `github_error` 502 (non-201 response *or* any `requests.RequestException`).
Audit: `register(..., "post")`; no `target_field`.
Hint key on failing envelopes (only when improve is configured, never on `improve.report`'s own errors): `"hint": "If this blocked your task, call improve.report (kind=gap) to file it."`
Settings: `improve_github_repo: str = ""` (env `IMPROVE_GITHUB_REPO`, `owner/name`), `improve_github_token: SecretStr = SecretStr("")` (env `IMPROVE_GITHUB_TOKEN`). Both non-empty ⇒ enabled.
Issue: `POST https://api.github.com/repos/{repo}/issues`, JSON `{"title", "body", "labels": [kind]}`, headers `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `timeout=30`. Expect 201.
Issue body template (fixed headings, machine-parseable for the future fixer agent):
```
## Reporter
<actor email, or "<interface>:<caller name>" when no actor>

## Kind
gap|skill

## Report
<body>

## Context            (gap only)
- verb: ...
- error_code: ...
- request_id: ...
- workaround: ...

## Proposal           (only when proposal given)
```markdown
<proposal>
```
```

---

## T1 — `improve.report` verb, settings, registration, tests
**Exists because:** without the verb nothing captures a gap from Desktop/web; without settings it can't be fail-closed.
**Model:** sonnet
**Files:** `src/charter/settings.py` (add 2 fields), new `src/charter/improve.py`, `src/charter/main.py` (import, register, `_ALWAYS_ALLOWED`), new `tests/test_improve.py`.
**Follows:** built-in verb pattern of `identity.whoami` (`src/charter/identity_verbs.py`, registered at `main.py:98`); secret field pattern `personal_access_token: SecretStr` (`settings.py:62-69`); outbound HTTP + test fake pattern in `src/charter/packs/airtable/airtable_rw.py` and `tests/test_airtable_rw.py:13-31`; end-to-end test scaffold `FakeRequest`/`_as_caller` in `tests/test_identity_verbs.py:11-30`.

**Steps (test first).** Create `tests/test_improve.py`:
```python
"""improve.report: files a GitHub issue; scope-exempt, not actor-exempt; fail-closed."""
import json
import requests

import charter.main as main
from charter import improve


class FakeRequest:
    def __init__(self, headers=None, body=None):
        self.headers = headers or {}
        self._body = body or {}
    def get_json(self, silent=False):
        return self._body


class FakeResp:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._p = payload
    def json(self):
        return self._p


def _parse(resp):
    body, status, _h = resp
    return json.loads(body), status


def _as_caller(monkeypatch, require_actor=False, allow=("*",), scope_ok=True):
    monkeypatch.setattr(main, "identify",
                        lambda req: {"name": "marketer", "interface": "plugin",
                                     "allow": list(allow), "require_actor": require_actor})
    monkeypatch.setattr(main, "allowed", lambda caller, verb: scope_ok)
    monkeypatch.setattr(main, "record", lambda *a, **k: None)


def _enable(monkeypatch):
    monkeypatch.setenv("IMPROVE_GITHUB_REPO", "acme/tools")
    monkeypatch.setenv("IMPROVE_GITHUB_TOKEN", "ghp_secret")


def _capture_post(monkeypatch, status=201, payload=None):
    calls = []
    def fake_post(url, **kw):
        calls.append((url, kw))
        return FakeResp(status, payload or {"html_url": "https://github.com/acme/tools/issues/7", "number": 7})
    monkeypatch.setattr(improve.requests, "post", fake_post)
    return calls


GAP = {"verb": "improve.report", "kind": "gap", "title": "deal.update rejects empty stage",
       "body": "Tried to clear stage; got bad_stage. Worked around by setting 'none'.",
       "context": {"verb": "crm.deal.update", "error_code": "bad_stage", "request_id": "r1",
                   "workaround": "set stage to 'none'"}}


def test_disabled_when_unconfigured(monkeypatch):
    _as_caller(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: "sam@example.com")
    body, status = _parse(main.bridge(FakeRequest(body=GAP)))
    assert status == 503 and body["error"] == "improve_disabled"


def test_gap_files_issue_with_template(monkeypatch):
    _enable(monkeypatch); _as_caller(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: "sam@example.com")
    calls = _capture_post(monkeypatch)
    body, status = _parse(main.bridge(FakeRequest(body=GAP)))
    assert status == 200 and body["ok"] is True
    assert body["issue"].endswith("/issues/7") and body["number"] == 7 and body["target"] == "issue:7"
    url, kw = calls[0]
    assert url == "https://api.github.com/repos/acme/tools/issues"
    assert kw["headers"]["Authorization"] == "Bearer ghp_secret"
    assert kw["timeout"] == 30
    assert kw["json"]["labels"] == ["gap"]
    text = kw["json"]["body"]
    for heading in ("## Reporter\nsam@example.com", "## Kind\ngap", "## Report\n", "## Context\n",
                    "- verb: crm.deal.update", "- error_code: bad_stage", "- workaround: set stage to 'none'"):
        assert heading in text
    assert "## Proposal" not in text


def test_skill_requires_proposal_and_fences_it(monkeypatch):
    _enable(monkeypatch); _as_caller(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    calls = _capture_post(monkeypatch)
    skill = {"verb": "improve.report", "kind": "skill", "title": "weekly digest", "body": "share with team"}
    body, status = _parse(main.bridge(FakeRequest(body=skill)))
    assert status == 400 and body["error"] == "missing_field"
    skill["proposal"] = "# Weekly digest\n\nDo the thing."
    body, status = _parse(main.bridge(FakeRequest(body=skill)))
    assert status == 200
    text = calls[0][1]["json"]["body"]
    assert "## Reporter\nplugin:marketer" in text
    assert "## Proposal\n```markdown\n# Weekly digest" in text
    assert calls[0][1]["json"]["labels"] == ["skill"]


def test_bad_kind_and_missing_fields(monkeypatch):
    _enable(monkeypatch); _as_caller(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    _capture_post(monkeypatch)
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "improve.report", "kind": "bug", "title": "t", "body": "b"})))
    assert status == 400 and body["error"] == "bad_kind"
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "improve.report", "kind": "gap", "title": "t"})))
    assert status == 400 and body["error"] == "missing_field"
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "improve.report", "kind": "gap", "title": "t", "body": "b", "proposal": 5})))
    assert status == 400 and body["error"] == "bad_proposal"


def test_too_large(monkeypatch):
    _enable(monkeypatch); _as_caller(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    calls = _capture_post(monkeypatch)
    big = dict(GAP, proposal="x" * (improve.MAX_BODY_BYTES + 1))
    body, status = _parse(main.bridge(FakeRequest(body=big)))
    assert status == 413 and body["error"] == "too_large" and calls == []


def test_github_failure_maps_to_502_without_token(monkeypatch):
    _enable(monkeypatch); _as_caller(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    _capture_post(monkeypatch, status=401, payload={"message": "Bad credentials"})
    body, status = _parse(main.bridge(FakeRequest(body=GAP)))
    assert status == 502 and body["error"] == "github_error"
    assert "ghp_secret" not in json.dumps(body)


def test_github_unreachable_maps_to_502(monkeypatch):
    _enable(monkeypatch); _as_caller(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    def boom(url, **kw):
        raise requests.Timeout("read timed out")
    monkeypatch.setattr(improve.requests, "post", boom)
    body, status = _parse(main.bridge(FakeRequest(body=GAP)))
    assert status == 502 and body["error"] == "github_error"
    assert "ghp_secret" not in json.dumps(body)


def test_scope_exempt_but_not_actor_exempt(monkeypatch):
    _enable(monkeypatch)
    _as_caller(monkeypatch, allow=(), scope_ok=False)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    _capture_post(monkeypatch)
    # scope: a caller allowed nothing can still report
    body, status = _parse(main.bridge(FakeRequest(body=GAP)))
    assert status == 200
    # ...but the same caller is still denied other verbs
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "identity.whoami"})))
    assert status == 403 and body["error"] == "denied"
    # actor: a require_actor key with no human behind it cannot report
    _as_caller(monkeypatch, require_actor=True, allow=(), scope_ok=False)
    body, status = _parse(main.bridge(FakeRequest(body=GAP)))
    assert status == 401 and body["error"] == "actor_required"


def test_no_audit_row_before_validation(monkeypatch):
    """Audit policy is post: a hostile title must not reach an attempt row."""
    _enable(monkeypatch); _as_caller(monkeypatch)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    rows = []
    monkeypatch.setattr(main, "record", lambda caller, verb, target, result, **k: rows.append((result, target)))
    _capture_post(monkeypatch)
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "improve.report", "kind": "bug",
                                                        "title": "x" * 100_000, "body": "b"})))
    assert status == 400
    assert [r for r, _ in rows] == ["bad_kind"]          # one post row, no "attempt"
    assert all(t is None or len(t) < 200 for _, t in rows)


def test_listed_for_everyone_and_is_write(monkeypatch):
    _as_caller(monkeypatch, allow=(), scope_ok=False)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "verbs.list"})))
    assert status == 200
    assert body["verbs"]["improve.report"]["read"] is False
    assert body["verbs"]["improve.report"]["summary"]
```
Note on `test_no_audit_row_before_validation`: `main.record` is called with positional `(caller, verb, target, result)` plus kwargs (`main.py` uses `record(caller, verb, target, e.code, rid=rid, detail=..., on_behalf_of=...)`). If the real signature differs, adapt the lambda's positional names, not the assertion.

Run: `.venv/bin/python -m pytest -q tests/test_improve.py` → fails (module missing).

Then `src/charter/settings.py`: beside `dropboxsign_token` add
```python
improve_github_repo: str = ""                    # owner/name; empty disables improve.report
improve_github_token: SecretStr = SecretStr("")  # fine-grained PAT, issues:write on that one repo
```

Then create `src/charter/improve.py`:
```python
"""Engine self-improvement verb: usage -> visible artifact.

improve.report files a GitHub issue against the configured repo so a gap the
agent hit (a verb that failed, was missing, or was worked around) or a skill a
user wants to share becomes something a maintainer -- or, later, an agent --
can pick up. Deliberate choices, each decided in the design record:

- Lives in the engine, not a pack, although it talks to a vendor. It reports
  on the engine's own verb surface and must exist in every deployment no
  matter which packs are loaded; the host is one config value, not an
  integration (no OAuth, no per-user credential, nothing flows from GitHub
  into verbs); unset disables it. A pack could not be scope-exempt or hook
  the error envelope without the engine naming it anyway.
- Scope-exempt (main._ALWAYS_ALLOWED): a `denied` on a verb the caller needed
  is itself a gap, so reporting cannot sit behind the grant it reports on.
- NOT actor-exempt: an issue must be attributable to whoever the key was
  configured to require.
- Audit policy "post", no target_field: a pre row keyed on a caller-supplied
  title would durably store unbounded text before validation. The issue is
  the durable record; the ok row carries issue:N.
"""
import requests

from charter import identity_context
from charter.errors import VerbError
from charter.settings import get_settings

KINDS = ("gap", "skill")
# GitHub caps issue bodies at 65,536 chars; leave headroom for the template.
MAX_BODY_BYTES = 60_000
_CONTEXT_KEYS = ("verb", "error_code", "request_id", "workaround")
HINT = "If this blocked your task, call improve.report (kind=gap) to file it."


def enabled():
    s = get_settings()
    return bool(s.improve_github_repo and s.improve_github_token.get_secret_value())


def _issue_body(kind, text, context, proposal, reporter):
    # Fixed headings on purpose: the design's north star is an agent that reads
    # these issues and opens PRs, so the shape is a contract, not prose.
    ctx = context if isinstance(context, dict) else {}
    lines = ["## Reporter", reporter, "", "## Kind", kind, "", "## Report", text]
    if kind == "gap":
        lines += ["", "## Context"]
        lines += [f"- {k}: {ctx.get(k) or ''}" for k in _CONTEXT_KEYS]
    if proposal:
        lines += ["", "## Proposal", "```markdown", proposal, "```"]
    return "\n".join(lines)


def report(body, caller):
    """File a gap or a skill proposal as a GitHub issue so the tool improves from use.
    Any authenticated caller may call this (scope-exempt) so a denied verb can be reported;
    kind is "gap" or "skill", and kind=skill requires proposal (the SKILL.md text)."""
    if not enabled():
        raise VerbError(503, "improve_disabled",
                        "IMPROVE_GITHUB_REPO / IMPROVE_GITHUB_TOKEN are not configured")
    kind = body.get("kind")
    if kind not in KINDS:
        raise VerbError(400, "bad_kind", "kind must be 'gap' or 'skill'")
    title, text = body.get("title"), body.get("body")
    if not (isinstance(title, str) and title.strip() and isinstance(text, str) and text.strip()):
        raise VerbError(400, "missing_field", "title and body are required non-empty strings")
    proposal = body.get("proposal")
    if proposal is not None and not isinstance(proposal, str):
        raise VerbError(400, "bad_proposal", "proposal must be a string")
    if kind == "skill" and not proposal:
        raise VerbError(400, "missing_field", "kind=skill requires proposal (the SKILL.md text)")
    ctx = identity_context.current()
    actor = ctx["actor"] if ctx else None
    reporter = actor or f"{caller['interface']}:{caller['name']}"
    issue_body = _issue_body(kind, text, body.get("context"), proposal, reporter)
    if len(issue_body.encode()) > MAX_BODY_BYTES:
        raise VerbError(413, "too_large", f"issue body exceeds {MAX_BODY_BYTES} bytes")
    s = get_settings()
    # ponytail: no per-actor rate limit; callers are org members behind Google
    # sign-in. Add a daily per-reporter cap if the repo ever gets spammed.
    try:
        r = requests.post(
            f"https://api.github.com/repos/{s.improve_github_repo}/issues",
            headers={"Authorization": f"Bearer {s.improve_github_token.get_secret_value()}",
                     "Accept": "application/vnd.github+json"},
            json={"title": title.strip()[:256], "body": issue_body, "labels": [kind]},
            timeout=30)
    except requests.RequestException as e:
        # Exception class only: a requests error message can include the URL
        # and headers, and the audit row must never carry the token.
        raise VerbError(502, "github_error", f"GitHub unreachable: {type(e).__name__}")
    if r.status_code != 201:
        # Status only. GitHub's error body never carries our token, but keeping
        # it out of the audit row is cheaper than proving that on every path.
        raise VerbError(502, "github_error", f"GitHub returned {r.status_code}")
    data = r.json()
    return {"issue": data["html_url"], "number": data["number"],
            "target": f"issue:{data['number']}"}
```

Then `src/charter/main.py`:
- add `from charter import improve` beside `from charter import results`.
- after `register("result.read", ...)` add `register("improve.report", improve.report, "post")`. No `read=` (the `report` leaf is not in `_READ_LEAVES`, so the convention already yields write), no `target_field` (see the docstring: the issue is the record).
- change `_ALWAYS_ALLOWED = {"verbs.list", "result.read"}` to `{"verbs.list", "result.read", "improve.report"}` and append to the comment block above it:
```
# improve.report joins _ALWAYS_ALLOWED for the opposite reason to result.read:
# not because a stricter check exists, but because a `denied` on a verb the
# caller needed is exactly the gap it exists to report. It stays out of
# _ACTOR_EXEMPT: an issue must be attributable. See charter/improve.py.
```
Run: `.venv/bin/python -m pytest -q tests/test_improve.py tests/test_identity_verbs.py tests/test_packtest.py tests/test_bridge.py`.

**Verify:** `.venv/bin/python -m pytest -q tests/test_improve.py` green, and `.venv/bin/python -m pytest -q` green.

---

## T2 — `hint` on failing envelopes
**Exists because:** use case 1 depends on the model remembering to report; a hint in the failure it just received is the cheapest capture-rate lever without auto-filing.
**Model:** sonnet
**Files:** `src/charter/main.py`, `tests/test_improve.py` (append).
**Consumes:** `improve.enabled()`, `improve.HINT` from T1.
**Follows:** the optional-key convention of `detail` in the `VerbError` branch (`main.py:294-300`).

**Steps (test first).** Append to `tests/test_improve.py`:
```python
# --- hint on failing envelopes ---------------------------------------------------

def test_hint_present_on_denied_unknown_and_verberror_when_enabled(monkeypatch):
    _enable(monkeypatch); _as_caller(monkeypatch, allow=(), scope_ok=False)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "identity.whoami"})))
    assert status == 403 and body["hint"] == improve.HINT
    _as_caller(monkeypatch)
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "no.such.verb"})))
    assert status == 404 and body["hint"] == improve.HINT
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "result.read", "id": "nope"})))
    assert body["ok"] is False and body["error"] == "result_unknown" and body["hint"] == improve.HINT


def test_hint_absent_when_disabled_and_on_improve_itself(monkeypatch):
    _as_caller(monkeypatch, allow=(), scope_ok=False)
    monkeypatch.setattr(main, "actor_email", lambda req: None)
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "identity.whoami"})))
    assert status == 403 and "hint" not in body
    _enable(monkeypatch); _as_caller(monkeypatch)
    _capture_post(monkeypatch)
    body, status = _parse(main.bridge(FakeRequest(body={"verb": "improve.report", "kind": "bug", "title": "t", "body": "b"})))
    assert status == 400 and "hint" not in body
```
(`results.fetch` raises `VerbError(404, "result_unknown")` for a bogus id — `src/charter/results.py:42-52` — so the `result.read` probe reaches the handler-`VerbError` branch; `result.read` is scope-exempt and not actor-gated here.)

Then in `main.py` add beside `_json`:
```python
def _with_hint(out, verb):
    """Point a failing caller at improve.report. Only when that verb is configured
    (a hint to a disabled verb is noise) and never on improve.report's own errors."""
    if verb != "improve.report" and improve.enabled():
        out["hint"] = improve.HINT
    return out
```
and wrap exactly three returns:
- denied: `return _json(_with_hint({"ok": False, "error": "denied", "request_id": rid}, verb), 403)`
- unknown_verb: `return _json(_with_hint({"ok": False, "error": "unknown_verb", "request_id": rid}, verb), 404)`
- handler `VerbError` branch: `return _json(_with_hint(out, verb), e.status)`
Leave `unauthorized`, `actor_required`, `write_in_read_tool`, `audit_unavailable`, `internal`, and the two auth-token `VerbError` branches untouched: those are not gaps in the toolbox.

**Verify:** `.venv/bin/python -m pytest -q tests/test_improve.py tests/test_bridge.py`.

---

## T3 — Plugin skills: report a gap, share a skill, maintainer triage; version bump
**Exists because:** the verb is inert unless the model is told when to call it; the maintainer skill is the manual precursor of the fixer agent.
**Model:** sonnet
**Files:** `plugin/skills/using-verbs.md` (append two sections + one error-codes bullet), new `plugin/skills/improve.md`, `plugin/.claude-plugin/plugin.json` (`"version": "0.2.0"` → `"0.3.0"`).
**Follows:** existing section style in `plugin/skills/using-verbs.md` (H1 + `##` sections, no frontmatter).

**Steps.** Append to `plugin/skills/using-verbs.md`:
```markdown
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
```
and under `## Error Codes` add the bullet:
```markdown
- `improve_disabled` — this deployment has not configured `improve.report`; tell the user what you would have filed
```
Create `plugin/skills/improve.md`:
```markdown
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
```
Bump `plugin/.claude-plugin/plugin.json` version to `0.3.0`.

**Verify:** `python3 -c "import json;print(json.load(open('plugin/.claude-plugin/plugin.json'))['version'])"` prints `0.3.0`; `grep -c 'improve.report' plugin/skills/using-verbs.md` ≥ 3; `test -f plugin/skills/improve.md`.

---

## T4 — Docs: configuration rows, feature doc, README section, distribution note
**Exists because:** an adopter cannot enable the verb without knowing the two env vars, and the README is where the thesis is meant to be visible.
**Model:** sonnet
**Files:** `docs/configuration.md`, new `docs/improve.md`, `README.md`, `docs/distribution.md`.
**Follows:** the Optional table format in `docs/configuration.md:13-27`; README's existing doc links in `## Architecture` / `## Configuration` (`README.md:123-128`).

**Steps.** In `docs/configuration.md` Optional table, after the `MAX_INLINE_BYTES` row add:
```
| `IMPROVE_GITHUB_REPO` | (empty) | `owner/name` of the GitHub repo `improve.report` files issues in. Empty disables the verb and the `hint` on failing responses |
| `IMPROVE_GITHUB_TOKEN` | (empty) | Fine-grained GitHub token with Issues: read and write on that one repo. Nothing else; it must not be able to push code |
```
Create `docs/improve.md`:
```markdown
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

Fixed headings so the body is machine-readable: Reporter, Kind, Report,
Context (gap: verb, error_code, request_id, workaround), Proposal (skill:
fenced markdown). The `request_id` joins the issue to the audit row. The issue
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
```
In `README.md`, add a short section after `## Stateless by construction` (before `## Why not the vendor's MCP server?`):
```markdown
## Gets smarter from use

The ideas for what a verb or skill should be come from usage, not only from
whoever wrote the pack. When an agent hits a gap — a verb that failed and was
worked around, one it needed and didn't have — or a user drafts a skill worth
sharing, `improve.report` files it as a GitHub issue from any Claude surface.
Failing responses carry a hint pointing at it. A maintainer skill turns the
issues into ordinary PRs; the next step is an agent that does that itself.
See [`docs/improve.md`](docs/improve.md).
```
In `docs/distribution.md` under "What the plugin carries" add `- \`skills/improve.md\` — maintainer triage of \`improve.report\` issues.`

**Verify:** `grep -q IMPROVE_GITHUB_TOKEN docs/configuration.md && grep -q 'docs/improve.md' README.md && test -f docs/improve.md && grep -q improve.md docs/distribution.md && echo ok`.

---

## After the build (not tasks in this plan)
- rc-data-tools: set the two env vars on core pointing at `jasonrr/rc-data-tools` (or wherever fixes land), create `gap`/`skill` labels, redeploy. Tracked as a tally todo.
- Design todo `t_dlbo6dh6wfw02` (maintainer skill reading audit failures) stays open.
