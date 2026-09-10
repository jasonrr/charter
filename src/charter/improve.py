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
    # these issues and opens PRs, so the shape is a contract, not prose. Report
    # is the only wholly free-form, unfenced caller text, so it is emitted
    # LAST -- every other heading (Reporter, Kind, Context, Proposal) is
    # written before it, which is what makes the first occurrence of each
    # heading in the document the authoritative one: Report can forge a later
    # copy of an earlier heading, but nothing caller-controlled follows Report
    # to forge a copy ahead of it.
    ctx = context if isinstance(context, dict) else {}
    lines = ["## Reporter", reporter, "", "## Kind", kind]
    if kind == "gap":
        lines += ["", "## Context"]
        lines += [f"- {k}: {ctx.get(k) or ''}" for k in _CONTEXT_KEYS]
    if proposal:
        # CommonMark: a fence closes at the first line of backticks >= the
        # opening run's length. Pick a run longer than any backtick run in
        # the proposal so caller text can never close the fence early.
        longest_run = 0
        run = 0
        for ch in proposal:
            run = run + 1 if ch == "`" else 0
            longest_run = max(longest_run, run)
        fence = "`" * max(3, longest_run + 1)
        lines += ["", "## Proposal", fence + "markdown", proposal, fence]
    lines += ["", "## Report", text]
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
    if (len(issue_body.encode("utf-8", "replace")) + len(title.encode("utf-8", "replace"))
            > MAX_BODY_BYTES):
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
    try:
        data = r.json()
        number, url = data["number"], data["html_url"]
    except (ValueError, KeyError, TypeError):
        # The issue exists; we just cannot name it. Never echo the body.
        raise VerbError(502, "github_error", "GitHub returned 201 with an unexpected body")
    return {"issue": url, "number": number, "target": f"issue:{number}"}
