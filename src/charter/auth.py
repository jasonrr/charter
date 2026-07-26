"""Caller identity + verb-prefix authorization for Charter.

Keys are a JSON map of sha256(key) -> {name, interface, allow}. The map key is
stored prefixed "sha256:<hexdigest>" (see example_keys.json) — populate the
secret with that prefix or lookups silently miss. The sha256 is a lookup index,
not a security boundary; keys are >=256-bit random.

The map is read LIVE from Secret Manager (`charter-keys` by default) and cached
for TTL_SECONDS, so add/rotate/revoke takes effect within the TTL with no redeploy.
`reload()` (exposed via the admin.reload_keys verb) forces an immediate refresh.
The CHARTER_KEYS env var is a cold-start fallback if Secret Manager is briefly
unreachable at boot. Loader and fail-closed handling live in charter.secret_map,
shared with the grants map.
"""
import hashlib
import logging
from fnmatch import fnmatchcase

from charter.secret_map import SecretMap
from charter.actor_auth import actor_email
from charter.grants import grants_for

_MAP = SecretMap("charter keys", "keys_secret_name", "charter_keys")


def _keys():
    """The cached key map (see charter.secret_map for TTL, fallback, fail-closed)."""
    return _MAP.get()


def reload():
    """Force the next _keys() to re-fetch from Secret Manager (post-rotation)."""
    _MAP.reload()


def identify(request):
    """Return the caller record for a valid X-API-Key, else None."""
    raw = request.headers.get("X-API-Key", "")
    if not raw:
        return None
    digest = "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()
    rec = _keys().get(digest)
    if rec is None:
        return None
    allow = rec["allow"]
    return {"name": rec["name"], "interface": rec.get("interface", "unknown"),
            # A COPY: this record is handed to every verb handler, and the list
            # in it is the cached key map's own list -- a handler appending to it
            # would widen the key's scope process-wide until the TTL expires.
            # Copied only when it IS a list: list("data.*") would explode a
            # malformed string allow into characters (see allowed()).
            "allow": list(allow) if isinstance(allow, list) else allow,
            "require_actor": bool(rec.get("require_actor"))}


def allowed(caller, verb):
    """True if the caller's allow-list grants this verb.

    Patterns are fnmatch globs, matched case-sensitively. A trailing-dot pattern
    is back-compat shorthand for a prefix: "sync." behaves as "sync.*". "*" grants
    everything; an exact name (no glob chars) matches only itself. Like AWS IAM, a
    "*" spans dots — so "content.*" grants all of content including publish, and a
    draft-only grant must be written "content.*.draft*" (anchored by the literal
    ".draft", which no publish verb contains).
    """
    def _match(p):
        if p.endswith("."):
            p += "*"
        return fnmatchcase(verb, p)
    allow = caller["allow"]
    # Fail closed on a malformed allow-list rather than matching through it. Both
    # maps are hand-edited secrets: a JSON string would match per-character (any
    # "*" grants everything) and a non-string element raises out of _match --
    # this call sits outside bridge()'s try block, so that is a bare 500.
    if not isinstance(allow, list) or not all(isinstance(p, str) for p in allow):
        logging.error("charter auth: malformed allow-list for %s -- fail-closed",
                      caller.get("name"))
        return False
    return any(_match(p) for p in allow)


def identify_by_actor(request):
    """(caller, verified email) from an actor identity — the OAuth path.

    Three outcomes, all distinguishable by the dispatcher, because they are not
    the same event to an auditor:
      (record, email) — verified email holding a grant
      (None, email)   — verified email with NO grant: still a known human, so
                        the dispatcher audits the attempt before its 401
      (None, None)    — no actor token at all: nothing to attribute
    A present-but-invalid token — forged, replayed, expired, wrong-aud — raises
    VerbError(401, "actor_invalid") through, so the keyless path audits it and
    answers exactly as the key path does instead of going silent.

    This runs ONLY when identify() found no API key; the X-API-Key path is
    unaffected.
    """
    email = actor_email(request)         # None when absent; raises when bad
    if not email:
        return None, None
    allow = grants_for(email)
    if allow is None:                    # fail-closed: no grant
        return None, email
    return {"name": email, "interface": "oauth", "allow": allow,
            "require_actor": False}, email
