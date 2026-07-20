"""Fixture pack whose registration contradicts the leaf read/write convention
(read=True on a *.delete verb) -> refused at import."""
from charter.sdk import register

name = "conflict"


def _delete(body, caller):
    """Fixture write handler."""
    return {"deleted": True}


register("test.conflict.delete", _delete, "post", read=True)
