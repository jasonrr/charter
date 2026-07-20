"""Fixture pack requiring a config key that does not exist -> boot-time
pack_config failure."""
from charter.sdk import register

name = "config"
required_config = ("nonexistent_pack_setting",)


def _noop(body, caller):
    """No-op fixture handler."""
    return {}


register("test.config.noop", _noop, "post")
