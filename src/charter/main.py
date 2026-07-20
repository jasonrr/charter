"""Charter HTTP entry point: auth -> verb dispatch -> audit.

One Cloud Function behind Cloudflare Access. Dispatches on body["verb"].
The VERBS registry maps verb -> (handler, audit_policy): "post" audits after
the handler (fail-open); "pre" writes a durable attempt row before the side
effect (fail-closed, 503 if the audit is unavailable).

VERBS is composed at import from engine registrations + packs loaded through
the public SDK (charter.sdk). The registry object IS sdk.VERBS, so tests
keep working via monkeypatch.setitem(main.VERBS, ...). Prefix-dispatched
families (data.warehouse.*) are registered through sdk.register_prefix with
catalog metadata, and verbs.list derives generically from those registrations.
"""
import json as _jsonlib
from uuid import uuid4

import functions_framework

from charter.auth import identify, allowed, reload as reload_keys
from charter.audit import record
from charter.errors import VerbError
from charter.actor_auth import actor_email
from charter.settings import get_settings
from charter import identity_context
from charter.identity_verbs import whoami
from charter.sdk import VERBS, PREFIXES, register, is_read, target_prefix, summary, _DRY_RUN
from charter.sdk import loader as _pack_loader

# Startup validation: a missing required config value fails the cold start here
# with a pydantic ValidationError naming the field, not a mid-request 500.
get_settings()


def _reload_keys(body, caller):
    """admin verb: force a live re-read of charter-keys (no redeploy)."""
    reload_keys()
    return {"reloaded": True}


# Discovery primitive: any authenticated caller may call verbs.list regardless of scope,
# so an agent can always learn its own toolbox. It reveals only the verbs the caller is
# already allowed to use, so it leaks nothing.
# (require_actor keys: this scope bypass does NOT skip the actor gate — discovery needs sign-in.)
_ALWAYS_ALLOWED = {"verbs.list"}


def _can(caller, verb):
    """Scope check, with the discovery primitive(s) always permitted."""
    return verb in _ALWAYS_ALLOWED or allowed(caller, verb)


def _is_read(verb):
    """True if the verb only reads (no side effect) — the single source of truth for
    read/write classification, shared by the verbs.list catalog flag and the read-only
    tool guard. Delegates to sdk.is_read: a declared exact-verb flag wins, then the
    registered prefix family's declared flag, then the action-leaf convention
    (read/list/fetch/query/schema/views/status)."""
    return is_read(verb)


def verbs_list(body, caller):
    """List the charter verbs your key can call, each with a docstring summary and read/write flag.
    The handler docstrings are the source of truth, so the catalog can't drift from the code. Any
    authenticated caller may call this."""
    out = {v: {"summary": summary(fn), "read": _is_read(v)}
           for v, (fn, _audit) in VERBS.items() if _can(caller, v)}
    for prefix, entry in PREFIXES.items():     # prefix-dispatched families, derived generically
        if _can(caller, entry.scope):
            out[prefix + "*"] = {"summary": entry.summary, "read": entry.read,
                                 "detail": entry.detail}
    return {"verbs": dict(sorted(out.items())), "target": "catalog"}


# The engine verb surface, registered through the same SDK packs use. Read flags
# are declared explicitly — a contradiction with the leaf convention would fail
# this import (PackError), not a request.
register("verbs.list", verbs_list, "post", read=True)
register("admin.reload_keys", _reload_keys, "post", read=False)
register("identity.whoami", whoami, "post")

# Packs: config-listed modules + allow-listed entry points (default: none).
_pack_loader.load_packs(get_settings())


def _json(obj, status):
    return (_jsonlib.dumps(obj), status, {"Content-Type": "application/json"})


def _target(body):
    """Best-effort audit target from the request body (used before the handler runs).
    Callers may pass an explicit `target`; otherwise fall back through common id keys."""
    t = (body.get("target") or body.get("email_id") or body.get("deal_id")
         or body.get("url") or body.get("folder_id") or body.get("file_id"))
    if t:
        return t
    vid = body.get("id")
    if vid:
        prefix = target_prefix(body.get("verb", ""))
        return f"{prefix}:{vid}" if prefix else str(vid)
    return None


@functions_framework.http
def bridge(request):
    rid = str(uuid4())
    body = request.get_json(silent=True) or {}
    verb = body.get("verb", "")
    target = _target(body)                     # computed once; reused by every branch
    caller = identify(request)                 # missing/unknown key -> None
    if caller is None:
        return _json({"ok": False, "error": "unauthorized", "request_id": rid}, 401)
    if not _can(caller, verb):
        record(caller, verb, None, "denied", rid=rid)
        return _json({"ok": False, "error": "denied", "request_id": rid}, 403)
    try:
        actor = actor_email(request)     # None when absent; raises VerbError when present-but-bad
    except VerbError as e:
        record(caller, verb, target, e.code, rid=rid, detail=e.detail)
        return _json({"ok": False, "verb": verb, "error": e.code, "detail": e.detail,
                      "request_id": rid}, e.status)
    if caller.get("require_actor") and not actor:
        record(caller, verb, target, "actor_required", rid=rid)
        return _json({"ok": False, "verb": verb, "error": "actor_required",
                      "detail": "Sign in first: call your identity provider login tool, then retry.",
                      "request_id": rid}, 401)
    identity_context.begin(actor, body.get("allow_shared_credential"))
    fn, audit = VERBS.get(verb, (None, None))
    if fn is None:                             # prefix-dispatched families
        for prefix, entry in PREFIXES.items():
            if verb.startswith(prefix):
                fn, audit = entry.handler, entry.audit_policy
                break
    if fn is None:
        return _json({"ok": False, "error": "unknown_verb", "request_id": rid}, 404)
    if body.get("read_only") and not _is_read(verb):   # read-only tool sent a write verb
        record(caller, verb, target, "write_in_read_tool", rid=rid, on_behalf_of=actor)
        return _json({"ok": False, "verb": verb, "error": "write_in_read_tool",
                      "detail": "This verb writes; call it with the write tool, not the read tool.",
                      "request_id": rid}, 403)
    if audit == "pre":                         # fail-closed: durable record before side effect
        # KTD-8: skip attempt row ONLY when verb declared dry_run support AND caller passes it
        if body.get("dry_run") and verb in _DRY_RUN:
            pass  # preview mode — no attempt row, no side effect (handler must honor dry_run)
        else:
            try:
                record(caller, verb, target, "attempt", rid=rid, fail_open=False,
                       on_behalf_of=actor)
            except Exception:
                return _json({"ok": False, "verb": verb, "error": "audit_unavailable",
                              "request_id": rid}, 503)
    try:
        result = fn(body, caller)
        audit_detail = result.pop("_audit_detail", None)   # server-side only, into the audit row
        if result.get("ok") is False:              # handler business-rejection (e.g. confirm gate)
            record(caller, verb, target, "rejected", rid=rid, on_behalf_of=actor)
            return _json({"verb": verb, "request_id": rid, **result}, 400)
        used = identity_context.credential_used()
        if used:
            result.setdefault("credential", used)
        # dry_run previews are audit-distinguishable from real executions —
        # the evidentiary value of the log depends on it.
        outcome = "dry_run" if body.get("dry_run") and verb in _DRY_RUN else "ok"
        record(caller, verb, result.get("target") or target, outcome, rid=rid,
               on_behalf_of=actor, credential=used, detail=audit_detail)  # fail-open
        return _json({"ok": True, "verb": verb, "request_id": rid, **result}, 200)
    except VerbError as e:                         # structured, audited, mapped HTTP status
        record(caller, verb, target, e.code, rid=rid, detail=e.detail,
               on_behalf_of=actor)
        out = {"ok": False, "verb": verb, "error": e.code, "request_id": rid}
        if e.detail:
            out["detail"] = e.detail
        return _json(out, e.status)
    except Exception as e:
        record(caller, verb, target, "error", rid=rid, detail=str(e),
               on_behalf_of=actor)
        return _json({"ok": False, "verb": verb, "error": "internal", "request_id": rid}, 500)
