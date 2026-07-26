"""Caller identity + verb-prefix authorization for Charter.

Keys are a JSON map of sha256(key) -> {name, interface, allow}. The map key is
stored prefixed "sha256:<hexdigest>" (see example_keys.json) — populate the
secret with that prefix or lookups silently miss. The sha256 is a lookup index,
not a security boundary; keys are >=256-bit random.

The map is read LIVE from Secret Manager (`charter-keys` by default) and cached
for TTL_SECONDS, so add/rotate/revoke takes effect within the TTL with no redeploy.
`reload()` (exposed via the admin.reload_keys verb) forces an immediate refresh.
The CHARTER_KEYS env var is a cold-start fallback if Secret Manager is briefly
unreachable at boot.
"""
import json
import time
import hashlib
import logging
from fnmatch import fnmatchcase

from google.cloud import secretmanager

from charter.settings import get_settings
from charter.actor_auth import actor_email
from charter.grants import grants_for

TTL_SECONDS = 60

_KEYS = None
_loaded_at = 0.0


def _sm_client():
    """Lazy Secret Manager client. Reads through module globals so a patched
    `auth.sm` keeps working; importing this module needs no credentials."""
    c = globals().get("sm")
    if c is None:
        c = globals()["sm"] = secretmanager.SecretManagerServiceClient()
    return c


def __getattr__(name):
    if name == "sm":
        return _sm_client()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def _secret_path():
    s = get_settings()
    return f"projects/{s.gcp_project}/secrets/{s.keys_secret_name}/versions/latest"


def _fetch():
    """Read the latest key map from Secret Manager (the live source of truth)."""
    resp = _sm_client().access_secret_version(name=_secret_path())
    return json.loads(resp.payload.data.decode("utf-8"))


def _keys():
    """Cached key map, refreshed from Secret Manager every TTL_SECONDS.

    A fetch error keeps the last-good map (auth survives a transient Secret
    Manager blip); only a cold start with no map yet falls back to the
    CHARTER_KEYS env var. `_loaded_at` is bumped on every attempt so a
    persistent outage doesn't hammer Secret Manager on every request.
    """
    global _KEYS, _loaded_at
    if _KEYS is None or (time.time() - _loaded_at) > TTL_SECONDS:
        try:
            _KEYS = _fetch()
        except Exception as e:
            logging.error("charter keys fetch failed: %s", e)
            if _KEYS is None:                       # cold-start fallback
                _KEYS = json.loads(
                    get_settings().charter_keys.get_secret_value() or "{}")
        _loaded_at = time.time()
    return _KEYS


def reload():
    """Force the next _keys() to re-fetch from Secret Manager (post-rotation)."""
    global _loaded_at
    _loaded_at = 0.0


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
    A present-but-invalid token raises VerbError(401, "actor_invalid") through
    (forged, replayed, expired, wrong-aud), so the keyless path logs and
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
