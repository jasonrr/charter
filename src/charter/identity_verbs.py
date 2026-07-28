"""Engine identity verbs: read-back of the caller's own auth surface.

identity.whoami answers "who am I, what can I call, and whose identity do I
act as?" using only data already visible to an authenticated caller (their
own key record + this request's verified actor). The whoami leaf is in the
read-leaf convention, so the read-only MCP tool can call it — it backs the
onboarding verify sequence (verbs.list -> login -> identity.whoami -> one
read verb).
"""
from charter import identity_context


def whoami(body, caller):
    """Show your caller name, verified actor, effective scopes, and credential mode.
    Any authenticated caller may call this; it reveals only what the caller already knows."""
    ctx = identity_context.current()
    actor = ctx["actor"] if ctx else None
    # actor_mode, NOT credential_mode. It used to be the latter, with the value
    # f"user:{actor}" — byte-identical to what a provider seam writes into
    # identity_context.credential_used when a real per-user UPSTREAM token was
    # used, and which the dispatcher returns as `credential` on every success.
    # So the one verb that reports identity was answering "are you connected to
    # the upstream?" with a confident-looking yes, for a value that only ever
    # described charter's own sign-in. Whether an upstream grant exists is a
    # question only the owning pack can answer (e.g. identity.hs.status).
    return {"caller": caller["name"],
            "actor": actor,
            "is_human": actor is not None,
            "scopes": caller["allow"],
            "actor_mode": "actor" if actor else "anonymous"}
