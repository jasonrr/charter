"""Smoke pack: one slow verb for proving a live deploy (request ceiling,
rotation under load). Inert unless PACKS names it; self-registers at import."""
import time

from charter.errors import VerbError
from charter.sdk import register

name = "smoke"
MAX_SECONDS = 600


def sleep(body, caller):
    """Sleep for `seconds` (int, 0..600) and report how long."""
    n = body.get("seconds")
    if type(n) is not int or not 0 <= n <= MAX_SECONDS:
        raise VerbError(400, "bad_seconds", f"seconds must be an int in 0..{MAX_SECONDS}")
    time.sleep(n)
    return {"slept": n}


register("smoke.sleep", sleep, read=False)
