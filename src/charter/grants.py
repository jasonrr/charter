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

from charter.secret_map import SecretMap, allow_list

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
    this email -- see secret_map.allow_list, shared with the key path, for
    which shapes and why each one matters.
    """
    entry = _MAP.get().get(email)
    if entry is None:
        return None
    return allow_list(entry, "charter grants", email)
