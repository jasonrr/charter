"""Cloudflare D1 over its REST API (cloudflare mode only).

Two things live in the one database: the `audit` table (audit.py) and the
`config` table, one JSON row per identification map -- `keys` and `grants`
(secret_map.py, and the `charter keys` / `charter grants` CLIs that write them).
A Worker secret is capped at 5.1 kB, which a ~20-person grants map already
exceeds; a D1 row holds up to 2 MB.

`creds` is (account_id, database_id, token). The engine takes it from Settings;
the CLI passes the three CF_* env vars so it works without engine config.
"""
import json

import requests

from charter.settings import get_settings

_URL = "https://api.cloudflare.com/client/v4/accounts/{acct}/d1/database/{db}/query"


def query(sql, params=(), *, creds=None):
    """Run one statement and return its result rows (list of dicts)."""
    if creds is None:
        s = get_settings()
        creds = (s.cf_account_id, s.cf_d1_database_id, s.cf_api_token.get_secret_value())
    acct, db, token = creds
    r = requests.post(
        _URL.format(acct=acct, db=db),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"sql": sql, "params": list(params)},
        timeout=(3, 5),      # connect, read: a dead D1 fails 'pre' audit in <=8 s, not 10
    )
    try:
        body = r.json() if r.content else {}
    except ValueError:
        body = {}
    if not r.ok or not body.get("success"):
        raise RuntimeError(f"d1 query failed: HTTP {r.status_code} {body.get('errors')}")
    # Strict on the shape: a "success" body without rows must raise, not read as
    # an empty result -- for secret_map an empty result means "no row", which
    # falls back to the env map.
    return body["result"][0]["results"]


def get_map(name, *, creds=None):
    """The JSON map stored under `name` in `config`, or None if there is no row.

    A row that exists but holds JSON `null` is `{}` (locked out), never None:
    None is reserved for the no-row case the env fallback keys on.
    """
    rows = query("SELECT value FROM config WHERE name = ?", [name], creds=creds)
    if not rows:
        return None
    value = json.loads(rows[0]["value"])
    return {} if value is None else value


def put_map(name, value, *, creds=None):
    """Replace the whole map stored under `name` (the row is created if absent)."""
    query("INSERT INTO config (name, value) VALUES (?, ?) "
          "ON CONFLICT(name) DO UPDATE SET value = excluded.value",
          [name, json.dumps(value)], creds=creds)
