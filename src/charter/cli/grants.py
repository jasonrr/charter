"""Grants CLI for Charter, cloudflare mode: the grants map lives in the D1
`config` table (row `grants`). GCP mode edits the Secret Manager secret
directly -- see docs/deployment/grants.md.

Usage:
    charter grants push <grants.json>    replace the whole map
    charter grants show                  print the live map
"""
import argparse
import json
import pathlib
import sys

from charter import d1
from charter.cli.keys import _d1_creds, _die, _cloudflare_mode
from charter.secret_map import allow_list


def _push(path):
    try:
        grants = json.loads(pathlib.Path(path).read_text())
    except (OSError, ValueError) as e:
        _die(f"{path}: {e}")
    if not isinstance(grants, dict):
        _die(f"{path} is not a JSON object")
    # Same validation the engine applies per lookup; here it fails the push
    # instead of silently locking one person out.
    bad = [email for email, rec in grants.items() if allow_list(rec, "charter grants", email) is None]
    if bad:
        _die(f"{path}: malformed entry for {', '.join(bad)} (want {{\"allow\": [..]}})")
    d1.put_map("grants", grants, creds=_d1_creds())
    print(f"pushed {len(grants)} grant(s) to D1; live within 60 s", file=sys.stderr)


def _show():
    print(json.dumps(d1.get_map("grants", creds=_d1_creds()) or {}, indent=2))


def main(argv=None):
    if not _cloudflare_mode():
        _die("charter grants works with CHARTER_BACKEND=cloudflare; on GCP edit the "
             "charter-grants secret (docs/deployment/grants.md)")
    parser = argparse.ArgumentParser(prog="charter grants")
    sub = parser.add_subparsers(dest="cmd", required=True)
    push = sub.add_parser("push", help="Replace the grants map from a JSON file")
    push.add_argument("file")
    push.set_defaults(func=lambda a: _push(a.file))
    sub.add_parser("show", help="Print the live grants map").set_defaults(func=lambda _a: _show())
    args = parser.parse_args(argv)
    args.func(args)
