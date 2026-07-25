"""Grants: which verbs a named person is granted.

A charter grants powers to named parties; this is that map. The interactive
(OAuth) path carries no API key, so authorization is derived from the verified
human identity instead. Grants are a JSON map
  { "jason@example.com": {"allow": ["data.*", "content.*.draft*"]}, ... }
read LIVE from Secret Manager (`charter-grants`) and cached for TTL_SECONDS,
exactly like auth.py's key map. `allow` is the same field name key records use —
one allow-list syntax (auth.allowed), two ways of being identified.

Fail-closed: an email with no grant returns None, so the caller is None -> 401.
The CHARTER_GRANTS env var is a cold-start fallback if Secret Manager is briefly
unreachable at boot.

ponytail: a little duplication with auth.py's cached-secret pattern beats a
premature shared abstraction across two 30-line loaders.
"""
import json
import time
import logging

from google.cloud import secretmanager

from charter.settings import get_settings

TTL_SECONDS = 60

_GRANTS = None
_loaded_at = 0.0


def _sm_client():
    """Lazy Secret Manager client. Reads through module globals so a patched
    `grants.sm` keeps working; importing this module needs no credentials."""
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
    return f"projects/{s.gcp_project}/secrets/{s.grants_secret_name}/versions/latest"


def _fetch():
    """Read the latest grants map from Secret Manager (the live source of truth)."""
    resp = _sm_client().access_secret_version(name=_secret_path())
    return json.loads(resp.payload.data.decode("utf-8"))


def _map():
    """Cached grants map, refreshed from Secret Manager every TTL_SECONDS.

    A fetch error keeps the last-good map (auth survives a transient Secret
    Manager blip); only a cold start with no map yet falls back to the
    CHARTER_GRANTS env var. `_loaded_at` is bumped on every attempt so a
    persistent outage doesn't hammer Secret Manager on every request.

    A payload of the wrong shape (not a JSON object -- e.g. a top-level array)
    is treated the same as a fetch failure: fail-closed, never raise, so a
    hand-edited secret can't turn a keyless request into an uncaught 500.
    """
    global _GRANTS, _loaded_at
    if _GRANTS is None or (time.time() - _loaded_at) > TTL_SECONDS:
        try:
            fetched = _fetch()
            if not isinstance(fetched, dict):
                raise ValueError(f"grants payload is a {type(fetched).__name__}, not an object")
            _GRANTS = fetched
        except Exception as e:
            # WARNING, not ERROR: grants is an optional feature -- a deployment
            # with no charter-grants secret at all logs this every TTL forever,
            # and that's a normal quiet state, not an incident.
            logging.warning("charter grants fetch failed: %s", e)
            if _GRANTS is None:                       # cold-start fallback
                try:
                    parsed = json.loads(
                        get_settings().charter_grants.get_secret_value() or "{}")
                    _GRANTS = parsed if isinstance(parsed, dict) else {}
                except Exception as e2:
                    logging.error("charter grants: CHARTER_GRANTS fallback invalid: %s", e2)
                    _GRANTS = {}
        _loaded_at = time.time()
    return _GRANTS


def reload():
    """Force the next _map() to re-fetch from Secret Manager (post-grant-edit)."""
    global _loaded_at
    _loaded_at = 0.0


def grants_for(email):
    """Allow-list granted to this email, else None (fail-closed).

    Also fails closed (logged, never raised) if the secret is malformed for
    this email: an entry that isn't an object, or an `allow` that isn't a
    list. The latter matters beyond a clean error message -- a JSON *string*
    `allow` would otherwise iterate as characters in auth.allowed, where any
    "*" character silently matches every verb and escalates to full scope.
    """
    entry = _map().get(email)
    if entry is None:
        return None
    if not isinstance(entry, dict):
        logging.error("charter grants: entry for %s is a %s, not an object -- fail-closed",
                      email, type(entry).__name__)
        return None
    allow = entry.get("allow")
    if not isinstance(allow, list):
        logging.error("charter grants: allow for %s is a %s, not a list -- fail-closed",
                      email, type(allow).__name__)
        return None
    return allow
