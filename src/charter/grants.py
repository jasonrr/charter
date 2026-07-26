"""Grants: which verbs a named person is granted.

A charter grants powers to named parties; this is that map. The interactive
(OAuth) path carries no API key, so authorization is derived from the verified
human identity instead. Grants are a JSON map
  { "jason@example.com": {"allow": ["data.*", "content.*.draft*"]}, ... }
read LIVE from Secret Manager (`charter-grants`) and cached for TTL_SECONDS
through the same loader auth.py's key map uses (charter.secret_map). `allow` is
the same field name key records use — one allow-list syntax (auth.allowed), two
ways of being identified.

Fail-closed: an email with no grant returns None, so the caller is None -> 401.
The CHARTER_GRANTS env var is a cold-start fallback if Secret Manager is briefly
unreachable at boot.
"""
import logging

from charter.secret_map import SecretMap

# WARNING, not ERROR, on a failed fetch: grants is an optional feature -- a
# deployment with no charter-grants secret at all would log an ERROR every TTL
# forever, and that's a normal quiet state, not an incident.
_MAP = SecretMap("charter grants", "grants_secret_name", "charter_grants",
                 fetch_log_level=logging.WARNING)


def reload():
    """Force the next lookup to re-fetch from Secret Manager (post-grant-edit)."""
    _MAP.reload()


def grants_for(email):
    """Allow-list granted to this email, else None (fail-closed).

    Returns a COPY: the list lives in the process-wide cached map and travels
    into the caller record every verb handler receives, so handing out the live
    object lets one handler widen this email's scope for every later request.

    Also fails closed (logged, never raised) if the secret is malformed for
    this email: an entry that isn't an object, an `allow` that isn't a list, or
    an element of `allow` that isn't a string. The last two matter beyond a
    clean error message -- a JSON *string* `allow` would otherwise iterate as
    characters in auth.allowed, where any "*" character silently matches every
    verb and escalates to full scope, and a non-string element (`[["*"]]`, a
    plausible typo for `["*"]`) raises out of auth.allowed before bridge()'s
    try block: a bare 500 with no audit row.
    """
    entry = _MAP.get().get(email)
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
    if not all(isinstance(p, str) for p in allow):
        logging.error("charter grants: allow for %s has a non-string element -- fail-closed",
                      email)
        return None
    return list(allow)
