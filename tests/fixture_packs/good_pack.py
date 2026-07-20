"""Fixture pack for sdk loader tests: exact verb + prefix family + required
config, registered through the public SDK at import (as real packs do)."""
from charter.sdk import register, register_prefix, get_config

name = "good"
required_config = ("gcp_project",)


def _echo(body, caller):
    """Echo args back, with the pack's validated project from get_config()."""
    return {"echo": body.get("args", {}), "project": get_config().gcp_project,
            "target": "fixture:echo"}


def _pref(body, caller):
    """Fixture prefix family handler: returns the verb leaf."""
    return {"leaf": body.get("verb", "").removeprefix("test.goodpref."),
            "target": "fixture:pref"}


register("test.good.echo", _echo, "post", read=False)
register_prefix("test.goodpref.", _pref,
                {"detail": "fixture prefix family", "read": True,
                 "scope": "test.goodpref.list"})
