"""Key-issuance CLI for Charter: list/add/revoke/rotate against Secret Manager, or the
D1 `config` row `keys` when CHARTER_BACKEND=cloudflare (needs CF_ACCOUNT_ID,
CF_D1_DATABASE_ID, CF_API_TOKEN -- from the environment or a .env file).

Also supports offline mint mode: prints a random key + the exact sha256:
JSON fragment for env config.

Usage:
    charter keys list
    charter keys add --name <name> --interface <iface> --allow <glob1,glob2>
    charter keys rotate --name <name>
    charter keys revoke --name <name>
    charter keys mint --name <name> [--interface <iface>] [--allow <globs>]
"""
import argparse
import hashlib
import json
import os
import secrets
import sys

import requests
from dotenv import find_dotenv, load_dotenv
from google.cloud import secretmanager

from charter import d1
from charter.settings import get_settings

_CF_VARS = ("CF_ACCOUNT_ID", "CF_D1_DATABASE_ID", "CF_API_TOKEN")


def _sm_client():
    return secretmanager.SecretManagerServiceClient()


def _secret_path(name):
    s = get_settings()
    return f"projects/{s.gcp_project}/secrets/{name}/versions/latest"


def _cloudflare_mode():
    # Read env directly, like _mint: the CLI must work before engine config exists.
    # .env from the CURRENT directory (find_dotenv's default walks up from this
    # file, which is wrong for a tool/site-packages install); never overrides env.
    load_dotenv(find_dotenv(usecwd=True))
    return (os.environ.get("CHARTER_BACKEND") or "gcp").strip().lower() == "cloudflare"


def _die(msg):
    print(msg, file=sys.stderr)
    sys.exit(1)


def _d1_creds():
    # Env (or .env, loaded by _cloudflare_mode) rather than get_settings(): the
    # CLI must work without the engine's required config.
    missing = [n for n in _CF_VARS if not os.environ.get(n)]
    if missing:
        _die(f"CHARTER_BACKEND=cloudflare: set {', '.join(missing)}")
    return tuple(os.environ[n] for n in _CF_VARS)


def _fetch_keys(create=False):
    """Read the current key map from Secret Manager (same secret the engine reads).

    Cloudflare mode: the D1 row. While there is no row the core serves
    CHARTER_KEYS (the CORE_CHARTER_KEYS secret), so a missing row starts from
    that same map when the operator exports it -- otherwise the first `add`
    would lock every existing key out the moment the row appeared.
    """
    if _cloudflare_mode():
        keys = d1.get_map("keys", creds=_d1_creds())
        if keys is None:
            try:
                keys = json.loads(os.environ.get("CHARTER_KEYS") or "{}")
            except ValueError:
                _die("CHARTER_KEYS is not valid JSON")
            if not isinstance(keys, dict):
                _die("CHARTER_KEYS is not a JSON object")
            if keys:
                print(f"no keys row in D1: seeding from CHARTER_KEYS ({len(keys)} key(s)). "
                      "Once the row exists the core ignores CORE_CHARTER_KEYS.", file=sys.stderr)
            elif not create:
                _die("no keys row in D1 yet; `charter keys add` creates it (export "
                     "CHARTER_KEYS first to carry existing keys over)")
            else:
                print("no keys row in D1: starting a new key map. Once it exists the core "
                      "ignores CORE_CHARTER_KEYS.", file=sys.stderr)
            return keys
        if not isinstance(keys, dict):
            _die("D1 config row 'keys' is not a JSON object")
        return keys
    resp = _sm_client().access_secret_version(
        name=_secret_path(get_settings().keys_secret_name))
    return json.loads(resp.payload.data.decode("utf-8"))


def _store_keys(keys):
    """Write the updated key map back to Secret Manager (digests only, never plaintext keys)."""
    if _cloudflare_mode():
        d1.put_map("keys", keys, creds=_d1_creds())
        print("wrote keys to D1; live within 60 s (or call admin.reload_keys)", file=sys.stderr)
        return
    s = get_settings()
    parent = f"projects/{s.gcp_project}/secrets/{s.keys_secret_name}"
    _sm_client().add_secret_version(
        parent=parent, payload={"data": json.dumps(keys, indent=2).encode()})


def _generate_key():
    """Generate a 256-bit random key."""
    return secrets.token_urlsafe(32)


def _sha256(key):
    return "sha256:" + hashlib.sha256(key.encode("utf-8")).hexdigest()


def _add(name, interface, allow, require_actor=False):
    keys = _fetch_keys(create=True)
    key = _generate_key()
    digest = _sha256(key)
    keys[digest] = {
        "name": name,
        "interface": interface,
        "allow": allow,
        "require_actor": require_actor,
    }
    _store_keys(keys)
    print(f"Added key for {name} (digest: {digest})")
    print(f"  Key (save this — it will not be shown again): {key}")
    return key


def _rotate(name):
    keys = _fetch_keys()
    # Find existing key by name
    old_digest = None
    for digest, rec in keys.items():
        if rec.get("name") == name:
            old_digest = digest
            break
    if old_digest is None:
        print(f"No key found for name: {name}", file=sys.stderr)
        sys.exit(1)
    # Generate new key, keep same metadata. The old digest stays live so the
    # consumer can switch without downtime; revoke it explicitly afterwards.
    new_key = _generate_key()
    new_digest = _sha256(new_key)
    keys[new_digest] = dict(keys[old_digest])
    _store_keys(keys)
    print(f"Rotated key for {name} (old digest still live: {old_digest})")
    print(f"  New key (save this — it will not be shown again): {new_key}")
    print(f"  After the consumer switches, run: charter keys revoke --digest {old_digest}")
    return new_key


def _revoke(name=None, digest=None):
    keys = _fetch_keys()
    if digest:
        to_remove = [digest] if digest in keys else []
    else:
        to_remove = [d for d, rec in keys.items() if rec.get("name") == name]
    if not to_remove:
        print(f"No key found for: {digest or name}", file=sys.stderr)
        sys.exit(1)
    for d in to_remove:
        del keys[d]
    _store_keys(keys)
    print(f"Revoked {len(to_remove)} key(s) for {digest or name}")


def _list():
    keys = _fetch_keys()
    for digest, rec in keys.items():
        print(f"{digest}: {rec['name']} ({rec.get('interface', 'unknown')}) allow={rec['allow']}")


def _mint(name, interface="api", allow=None, require_actor=False):
    """Offline mint: print a random key and the sha256 JSON fragment for env config."""
    key = _generate_key()
    digest = _sha256(key)
    fragment = {
        digest: {
            "name": name,
            "interface": interface,
            "allow": allow or ["*"],
            "require_actor": require_actor,
        }
    }
    # Offline: read the secret-name hint from env directly, never get_settings()
    # (which requires GCP_PROJECT et al.) — mint must work before Step 3 config.
    secret_name = os.environ.get("KEYS_SECRET_NAME", "charter-keys")
    print(f"Generated key for {name}:")
    print(f"  Key: {key}")
    print(f"  sha256 fragment (add to your {secret_name} secret):")
    print(json.dumps(fragment, indent=2))
    return key


def main(argv=None):
    parser = argparse.ArgumentParser(prog="charter")
    sub = parser.add_subparsers(dest="cmd", required=True)

    keys = sub.add_parser("keys", help="Key management")
    keys_sub = keys.add_subparsers(dest="keys_cmd", required=True)

    list_cmd = keys_sub.add_parser("list", help="List all keys")
    list_cmd.set_defaults(func=lambda _a: _list())

    add_cmd = keys_sub.add_parser("add", help="Add a new key")
    add_cmd.add_argument("--name", required=True)
    add_cmd.add_argument("--interface", default="api")
    add_cmd.add_argument("--allow", required=True, help="Comma-separated glob patterns")
    add_cmd.add_argument("--require-actor", action="store_true")
    add_cmd.set_defaults(func=lambda a: _add(a.name, a.interface, a.allow.split(","), a.require_actor))

    rotate_cmd = keys_sub.add_parser("rotate", help="Rotate a key")
    rotate_cmd.add_argument("--name", required=True)
    rotate_cmd.set_defaults(func=lambda a: _rotate(a.name))

    revoke_cmd = keys_sub.add_parser("revoke", help="Revoke a key by name (all digests) or one digest")
    revoke_cmd.add_argument("--name")
    revoke_cmd.add_argument("--digest")
    revoke_cmd.set_defaults(
        func=lambda a: _revoke(name=a.name, digest=a.digest) if (a.name or a.digest)
        else revoke_cmd.error("one of --name or --digest is required"))

    mint_cmd = keys_sub.add_parser("mint", help="Mint an offline key (prints JSON fragment)")
    mint_cmd.add_argument("--name", required=True)
    mint_cmd.add_argument("--interface", default="api")
    mint_cmd.add_argument("--allow", required=True, help="Comma-separated glob patterns")
    mint_cmd.add_argument("--require-actor", action="store_true",
                          help="Key rejects calls until a human actor signs in (except verbs.list)")
    mint_cmd.set_defaults(
        func=lambda a: _mint(a.name, a.interface, a.allow.split(","), a.require_actor))

    args = parser.parse_args(argv)
    run(args.func, args)


def run(func, args):
    """A D1 failure is an operator-facing message, not a traceback."""
    try:
        func(args)
    except (RuntimeError, requests.RequestException, ValueError) as e:
        _die(f"D1: {e}")


if __name__ == "__main__":
    main()
