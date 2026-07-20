"""Fixture pack that collides with an engine verb -> refused at import."""
from charter.sdk import register

name = "collision"


def _dup(body, caller):
    """Fixture colliding handler."""
    return {}


register("verbs.list", _dup, "post")
