"""Contract helpers for act-as connect verbs (docs/remote-mcp.md §4.8).

A gateway owns the browser half of connecting an upstream account; the verb
that spends the resulting code lives in a pack, inside core. Two checks are
what make that split safe, and neither can be enforced anywhere but here:

  * the redirect URI presented at exchange time must be one this deployment
    actually published, and
  * the upstream principal the code resolves to must be the SAME person as the
    verified charter actor.

The second is the whole security model. The gateway cannot check it — it never
sees the upstream identity — and nothing observable at its callback
distinguishes a genuine paste from a code an attacker obtained and talked
someone into pasting. Left to each pack, it is a convention enforced by review;
here it is one function, so "did this verb bind?" is answerable by grep.

Provider-neutral on purpose: a pack supplies its own error codes and its own
allow-list, and this module supplies the decisions.
"""
from charter.errors import VerbError


def allowed_redirect_uri(candidate, allowed, *, code="redirect_uri_not_allowed",
                         config_key="the redirect-URI allow-list"):
    """The caller's redirect_uri, exact-matched against `allowed`.

    Caller-supplied because the upstream binds the code to whatever URI was used
    at authorize time, so a verb cannot simply configure one. Exact match, no
    normalization: the upstream compares the authorize-time string byte for
    byte, and a gateway builds exactly one canonical string per provider, so
    "equal after tidying" is a difference that would only ever hide a
    misconfiguration.

    An empty allow-list disables the flow rather than defaulting to something.
    §4.7 already settled this shape for the sign-in secret — there is no
    degraded mode, an unset key is a named 503 — and the alternative here is
    worse than degraded: exchanging against a URI nobody serves turns a missing
    deploy key into an opaque rejection from the upstream.

    Returns the validated URI (the sole entry when the caller passed none).
    """
    allowed = tuple(allowed)
    if not allowed:
        raise VerbError(503, "connect_unconfigured",
                        f"{config_key} is unset on this deployment")
    if candidate is None or candidate == "":
        if len(allowed) > 1:
            raise VerbError(400, code,
                            "redirect_uri is required when more than one is "
                            "configured; pass the one the connect page showed")
        return allowed[0]
    if not isinstance(candidate, str) or candidate not in allowed:
        raise VerbError(400, code, f"redirect_uri is not in {config_key}")
    return candidate


def bind_actor(actor, upstream_principal, *, code="upstream_identity_mismatch",
               label="upstream", detail=None):
    """Require that the upstream account being connected IS the charter actor.

    `actor` is cryptographically verified (actor_auth); `upstream_principal` is
    whatever the upstream itself says the code belongs to — introspected from
    the token, never taken from the caller. Compared case-insensitively, since
    identity providers differ on case but not on identity.

    Fails closed on a missing or empty principal: an upstream that would not
    tell us who the token acts as cannot be bound, and an unbound grant is
    exactly the thing this check exists to refuse.
    """
    if not actor:
        raise VerbError(401, "actor_required",
                        "this verb acts as you, so it needs your verified identity")
    theirs = (upstream_principal or "").strip().lower()
    if not theirs or theirs != actor.strip().lower():
        raise VerbError(403, code, detail or (
            f"the {label} account {theirs or 'this code belongs to'} is not your "
            f"verified sign-in {actor}. Connect your own {label} login and retry."))
    return theirs
