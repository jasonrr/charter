"""Request-scoped identity context.

Carries which verified human this request acts for, whether the caller explicitly
allowed shared-credential fallback, and which credential a provider seam actually
used. The dispatcher calls begin() exactly once per request (unconditionally —
thread pools reuse threads, so never rely on a default); provider auth modules
read and annotate it. contextvars keep concurrent requests isolated.
"""
import contextvars

_CTX = contextvars.ContextVar("charter_identity", default=None)


def begin(actor, allow_shared):
    """Start this request's identity context (dispatcher only)."""
    _CTX.set({"actor": actor, "allow_shared": bool(allow_shared),
              "credential_used": None})


def current():
    """This request's context dict, or None outside a request."""
    return _CTX.get()


def credential_used():
    """Which credential a provider seam used this request ("user:<email>"/"app"), or None."""
    ctx = _CTX.get()
    return ctx["credential_used"] if ctx else None
