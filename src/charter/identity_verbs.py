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
    return {"caller": caller["name"],
            "actor": actor,
            "is_human": actor is not None,
            "scopes": caller["allow"],
            "credential_mode": f"user:{actor}" if actor else "app"}
