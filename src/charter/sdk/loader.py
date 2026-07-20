"""Pack discovery and loading for Charter.

Two mechanisms, one validation path:

  1. Entry points (group "charter.packs") — loaded ONLY when the distribution
     is also named in settings.packs. The allow-list intersection exists
     because ambient entry-point execution would let any installed package
     run code inside the audited boundary at boot.
  2. Config-listed module paths in settings.packs — a dotted module name, or
     a .py path (whose parent dir is inserted on sys.path so the pack source
     is importable inside the container).

Every loaded pack is logged at boot with its origin. Protocol: a pack exposes
`name` (str) and optionally `required_config` (an iterable of Settings
attribute names, each validated non-empty at boot). Registration happens at
pack import time via module-top sdk.register / sdk.register_prefix calls.
"""
import importlib
import importlib.metadata
import logging
import os
import pathlib
import sys

from charter.sdk import PackError

ENTRY_POINT_GROUP = "charter.packs"
_LOADED_PACKS = []   # (name, origin) — boot log + test introspection


def _validate(pack, settings, origin):
    """The pack Protocol check: a non-empty `name`, plus non-empty Settings
    values for every declared required_config key. Failures are PackErrors at
    boot, never mid-request."""
    name = getattr(pack, "name", None)
    if not isinstance(name, str) or not name:
        raise PackError(f"pack_validation: {origin} must expose a 'name' attribute")
    for key in getattr(pack, "required_config", ()):
        val = getattr(settings, key, None)
        if hasattr(val, "get_secret_value"):
            val = val.get_secret_value()
        if val is None or val == "" or val == ():
            raise PackError(
                f"pack_config: {origin} requires settings.{key} (unset or empty)")
    _LOADED_PACKS.append((name, origin))
    logging.info("charter pack loaded: %s (origin: %s)", name, origin)


def _import_pack(entry):
    """Import a config-listed pack: dotted module name, or a .py path whose
    parent dir is inserted on sys.path."""
    if entry.endswith(".py") or os.sep in entry:
        path = pathlib.Path(entry).resolve()
        parent = str(path.parent)
        if parent not in sys.path:
            sys.path.insert(0, parent)
        return importlib.import_module(path.stem)
    return importlib.import_module(entry)


def load_packs(settings):
    """Discover, validate, and load every pack named by settings.packs.
    Entry-point distributions named in settings.packs load via their entry
    point; any remaining entry is imported as a module."""
    allow = set(settings.packs)
    loaded_dists = set()
    for ep in importlib.metadata.entry_points(group=ENTRY_POINT_GROUP):
        dist = getattr(ep, "dist", None)
        dist_name = (dist.metadata.get("Name") if dist is not None else "") or ""
        if dist_name not in allow:
            logging.warning(
                "charter pack %r refused: distribution %r is not "
                "allow-listed in settings.packs", ep.name, dist_name)
            continue
        obj = ep.load()
        if callable(obj) and not hasattr(obj, "name"):
            obj = obj()          # factory-style entry point
        _validate(obj, settings, f"entry-point:{dist_name}")
        loaded_dists.add(dist_name)
    for entry in settings.packs:
        if entry in loaded_dists:
            continue             # already loaded via its distribution entry point
        _validate(_import_pack(entry), settings, entry)
