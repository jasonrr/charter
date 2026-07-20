"""packtest CLI: one command, JSON-lines output, exit code = the agent's signal.

Usage:
    python -m charter.packtest --pack path/to/pack.py [--pack another.py] [--json]

Each output line is one JSON record: {check, verb, failure, suggested_fix,
level, failure_class}. Non-zero exit when any record is a failure; zero when
the pack is clean (warnings do not fail the run — degraded discovery is
advisory, a write named with a read leaf is not).

The output is the authoring agent's correction loop: every record names the
check, the verb, the machine-matchable failure code, and the concrete fix.
"""
import argparse
import dataclasses
import importlib
import importlib.util
import json
import sys
from pathlib import Path

from charter.packtest import checks


def _dotted_if_packaged(p):
    """Dotted name for a path inside an importable package, else None.

    Path-loading a file that lives in an installed package double-registers
    its verbs: the file's own absolute imports run the real package __init__
    through the normal import machinery first, then exec_module runs it again.
    """
    if p.suffix != ".py":
        return None
    parts = [] if p.name == "__init__.py" else [p.stem]
    cur = p.parent
    while (cur / "__init__.py").exists():
        parts.append(cur.name)
        cur = cur.parent
    if not parts:
        return None
    dotted = ".".join(reversed(parts))
    try:
        return dotted if importlib.util.find_spec(dotted) else None
    except (ImportError, ValueError):
        return None


def _load_pack(path):
    """Import a pack by dotted module name, .py file path, or package directory
    (registration runs at import)."""
    if Path(path).is_dir():
        path = str(Path(path) / "__init__.py")
    if path.endswith(".py") or "/" in path:
        dotted = _dotted_if_packaged(Path(path).resolve())
        if dotted:
            return importlib.import_module(dotted)
        spec = importlib.util.spec_from_file_location(
            "packtest_target_" + str(abs(hash(path))), path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    return importlib.import_module(path)


def _snapshot_registry():
    import charter.sdk as sdk
    return (dict(sdk.VERBS), dict(sdk.PREFIXES),
            dict(getattr(sdk, "_DECLARED_READ", {})),
            set(getattr(sdk, "_DRY_RUN", set())))


def _restore_registry(snap):
    import charter.sdk as sdk
    verbs, prefixes, declared, dry = snap
    sdk.VERBS.clear()
    sdk.VERBS.update(verbs)
    sdk.PREFIXES.clear()
    sdk.PREFIXES.update(prefixes)
    declared_r = getattr(sdk, "_DECLARED_READ", None)
    if declared_r is not None:
        declared_r.clear()
        declared_r.update(declared)
    dry_s = getattr(sdk, "_DRY_RUN", None)
    if dry_s is not None:
        dry_s.clear()
        dry_s.update(dry)


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="charter-packtest",
        description="Charter pack conformance suite (U4) — MCP spec pin "
                    + checks.SPEC_PIN)
    parser.add_argument("--pack", action="append", required=True,
                        help="path to a pack .py file (repeatable)")
    parser.add_argument("--json", action="store_true",
                        help="emit JSON lines (default; kept for explicitness)")
    args = parser.parse_args(argv)

    records = []
    for path in args.pack:
        snap = _snapshot_registry()
        try:
            module = _load_pack(path)
            for result in checks.evaluate_pack(module):
                records.append(dataclasses.asdict(result))
        finally:
            _restore_registry(snap)

    out = sys.stdout
    for rec in records:
        out.write(json.dumps(rec) + "\n")

    failed = any(r["level"] == "failure" for r in records)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
