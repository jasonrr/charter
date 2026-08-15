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

from charter.auth import identify, identify_by_actor, allowed, reload as reload_keys
from charter.grants import grants_for, reload as reload_grants
from charter.audit import begin_trace, record
from charter.errors import VerbError
from charter.actor_auth import actor_email
from charter.settings import get_settings
from charter import identity_context
from charter.identity_verbs import whoami
from charter import results
from charter.sdk import (VERBS, PREFIXES, register, is_read, target_prefix,
                         target_field, summary, _DRY_RUN)
from charter.sdk import loader as _pack_loader

# Startup validation: a missing required config value fails the cold start here
# with a pydantic ValidationError naming the field, not a mid-request 500.
get_settings()


def _reload_keys(body, caller):
    """admin verb: force a live re-read of charter-keys and charter-grants (no redeploy)."""
    reload_keys()
    reload_grants()
    return {"reloaded": True}


# Discovery primitive: any authenticated caller may call verbs.list regardless of scope,
# so an agent can always learn its own toolbox. It reveals only the verbs the caller is
# already allowed to use, so it leaks nothing.
# result.read joins verbs.list here: its authorization is OWNERSHIP (only the caller
# record that produced a result may fetch it — enforced in results.fetch), which
# is stricter than any grant pattern; requiring a result.* grant would only lock
# humans out of their own results.
#
# _ALWAYS_ALLOWED is SCOPE-exempt only. The require_actor gate below answers a
# different question — whether a human must be behind this call — and the two
# verbs split on it:
#   - verbs.list is also actor-exempt (_ACTOR_EXEMPT): an agent must be able to
#     inspect its toolbox before a human signs in, and a valid key with no actor
#     leaks nothing new by listing it.
#   - result.read is NOT actor-exempt: ownership authorizes WHICH blobs a caller
#     may fetch, but it does not waive the human-presence requirement that
#     caller's key was configured with. A bare leaked require_actor key must not
#     be able to read a blob its human produced.
_ALWAYS_ALLOWED = {"verbs.list", "result.read"}
_ACTOR_EXEMPT = {"verbs.list"}


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


def _producer(caller):
    """Producer identity for the results store, namespaced by interface so a key
    named like a granted email can never collide with that human's OAuth identity
    (interface is "oauth" for a verified human, "api"/"plugin"/etc. for a key)."""
    return f"{caller['interface']}:{caller['name']}"


def result_read(body, caller):
    """Fetch a previously offloaded oversized result by id (producer-only). Returns the
    stored envelope as a JSON string; meant for the gateway's resource fetch, not for
    inlining into a model's context."""
    rid_arg = body.get("id")
    content = results.fetch(rid_arg if isinstance(rid_arg, str) else "", _producer(caller))
    return {"content": content, "mime": "application/json",
            "target": f"result:{rid_arg[:64] if isinstance(rid_arg, str) else ''}"}


register("result.read", result_read, "post", read=True)

# Packs: config-listed modules + allow-listed entry points (default: none).
_pack_loader.load_packs(get_settings())


def _json(obj, status):
    return (_jsonlib.dumps(obj), status, {"Content-Type": "application/json"})


def _success(verb, rid, caller, result):
    """The 200 envelope, offloading oversize bodies to the results store (§4.5).

    Runs AFTER the ok audit row: the verb's outcome is a fact by now, so a dead
    bucket must not turn a success into an error. Fail-open to the inline body —
    the gateway's 1 MB cap still bounds what can reach a model's context.
    result.read is exempt or a fetched blob would just be re-offloaded.
    """
    payload = {"ok": True, "verb": verb, "request_id": rid, **result}
    encoded = _jsonlib.dumps(payload)
    cfg = get_settings()
    if (not cfg.results_bucket or verb == "result.read"
            or len(encoded.encode()) <= cfg.max_inline_bytes):
        return (encoded, 200, {"Content-Type": "application/json"})
    try:
        ref = results.store(encoded, _producer(caller), verb)
    except Exception:
        return (encoded, 200, {"Content-Type": "application/json"})
    return _json({"ok": True, "verb": verb, "request_id": rid,
                  "result_ref": {"id": ref, "bytes": len(encoded.encode()),
                                 "mime": "application/json"}}, 200)


def _target(body):
    """Best-effort audit target from the request body (used before the handler runs).
    Precedence: explicit `target` -> the verb's registered target_field (labelled by
    its target_prefix when declared, matching the post-audit "<prefix>:<id>" shape)
    -> the legacy common-id-key chain for undeclared verbs."""
    t = body.get("target")
    if t:
        return t
    verb = body.get("verb")
    verb = verb if isinstance(verb, str) else ""   # body is raw JSON; never let a
    field = target_field(verb)                     # non-string verb 500 the audit path
    if field:
        v = body.get(field)
        if v:
            prefix = target_prefix(verb)
            return f"{prefix}:{v}" if prefix else str(v)
    t = (body.get("email_id") or body.get("deal_id")
         or body.get("url") or body.get("doc_id") or body.get("folder_id") or body.get("file_id"))
    if t:
        return t
    vid = body.get("id")
    if vid:
        prefix = target_prefix(verb)
        return f"{prefix}:{vid}" if prefix else str(vid)
    return None


# The actor_invalid row below is the one audit write reachable with no
# credential at all -- a garbage X-Actor-Token is the whole trigger -- and
# fail_open means nothing pushes back. Its target is dropped entirely (the
# `denied` branch already does that) and its verb is bounded to this. Long
# enough for any real verb by a wide margin; short enough that the row is not
# a place to park data.
_MAX_UNAUTHENTICATED_VERB = 120


def _bounded_verb(verb):
    """`verb` trimmed for an audit row written without a credential.

    Non-strings become "": `verb` comes straight off the JSON body, so it can
    be an object or an array, and slicing one raises -- which is the unaudited
    bare 500 this branch exists to avoid.
    """
    return verb[:_MAX_UNAUTHENTICATED_VERB] if isinstance(verb, str) else ""


@functions_framework.http
def bridge(request):
    rid = str(uuid4())
    # Before the first record() below can run. `rid` identifies this call inside
    # charter; the traceparent is what joins it to the caller's own trace, which
    # is the only way an operator gets from a slow tool call in their client to
    # the audit row it produced. Unconditional: see begin_trace's docstring.
    begin_trace(request.headers.get("traceparent"))
    body = request.get_json(silent=True) or {}
    verb = body.get("verb", "")
    target = _target(body)                     # computed once; reused by every branch
    caller = identify(request)                 # X-API-Key -> caller (headless)
    from_key = caller is not None
    if caller is None:                         # no key: try the OAuth identity path
        # ponytail: an unknown key is treated as no key. Revoking a key does
        # not revoke a human's grant -- revoke that in charter-grants.
        try:
            caller, email = identify_by_actor(request)   # verified actor + grants
        except VerbError as e:
            # Present-but-bad token: audited and answered here exactly as the
            # key path answers it below, so a forged or expired token is not
            # quieter just because it arrived without a key.
            record(None, _bounded_verb(verb), None, e.code, rid=rid,
                   detail=e.detail)
            return _json({"ok": False, "verb": verb, "error": e.code,
                          "detail": e.detail, "request_id": rid}, e.status)
        if caller is None and email:
            # Verified human, no grant. The identity is known and the probe is
            # evidence, so audit it -- then fall through to the SAME generic 401
            # an anonymous request gets, which leaks nothing about who is granted.
            record({"name": email, "interface": "oauth"}, verb, target, "no_grant",
                   rid=rid)
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
    if caller.get("require_actor") and not actor and verb not in _ACTOR_EXEMPT:
        record(caller, verb, target, "actor_required", rid=rid)
        return _json({"ok": False, "verb": verb, "error": "actor_required",
                      "detail": "Sign in first: call your identity provider login tool, then retry.",
                      "request_id": rid}, 401)
    if from_key and actor and grants_for(actor) is not None:
        # The key's allow-list governs this call (identify() wins), yet the
        # verified human it is layered on holds their own grant. Legitimate
        # for headless key+actor -- but the same precedence once made grants
        # dead config behind a gateway key (docs/remote-mcp.md §4.1), and the
        # reference gateway's no-key rule is not binding on other front ends,
        # so the override is recorded rather than silent.
        record(caller, verb, target, "key_overrode_grant", rid=rid,
               on_behalf_of=actor)
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
        return _success(verb, rid, caller, result)
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
