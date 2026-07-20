"""Fixture pack missing the required `name` attribute -> boot-time protocol
validation failure."""
from charter.sdk import register


def _noop(body, caller):
    """No-op fixture handler."""
    return {"ok": True}


register("test.bad.noop", _noop, "post")
