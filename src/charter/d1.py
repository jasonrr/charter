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
    return (body.get("result") or [{}])[0].get("results") or []


def get_map(name, *, creds=None):
    """The JSON map stored under `name` in `config`, or None if there is no row."""
    rows = query("SELECT value FROM config WHERE name = ?", [name], creds=creds)
    return json.loads(rows[0]["value"]) if rows else None


def put_map(name, value, *, creds=None):
    """Replace the whole map stored under `name` (the row is created if absent)."""
    query("INSERT INTO config (name, value) VALUES (?, ?) "
          "ON CONFLICT(name) DO UPDATE SET value = excluded.value",
          [name, json.dumps(value)], creds=creds)
