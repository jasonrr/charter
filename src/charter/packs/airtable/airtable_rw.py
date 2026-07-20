"""Minimal Airtable client for the reference pack.

Three generic primitives (get_record / list_records / patch_records) over the
Airtable REST API. Business-shaped readers belong in the pack that owns the
business logic, not here.

Always returnFieldsByFieldId=true so callers key on stable field ids, not
display names.

The Airtable base ID is pack-configured (not hardcoded): set AIRTABLE_BASE_ID
and PERSONAL_ACCESS_TOKEN in your environment.
"""
import requests

from charter.settings import get_settings


def _base_id():
    """Pack config: the Airtable base ID."""
    s = get_settings()
    return getattr(s, "airtable_base_id", "") or "appXXXXXXXXXXXXXX"


def _api():
    return f"https://api.airtable.com/v0/{_base_id()}"


def _headers():
    token = get_settings().personal_access_token.get_secret_value()
    if not token:
        raise KeyError("PERSONAL_ACCESS_TOKEN")
    return {"Authorization": f"Bearer {token}"}


def get_record(table_id, record_id):
    """Fetch one record's fields, keyed by field id."""
    r = requests.get(f"{_api()}/{table_id}/{record_id}",
                     headers=_headers(), params={"returnFieldsByFieldId": "true"}, timeout=30)
    r.raise_for_status()
    return r.json()["fields"]


def list_records(table_id, filter_formula=""):
    """All records matching filter_formula (follows Airtable pagination)."""
    params = {"pageSize": 100, "returnFieldsByFieldId": "true"}
    if filter_formula:
        params["filterByFormula"] = filter_formula
    records = []
    while True:
        r = requests.get(f"{_api()}/{table_id}", headers=_headers(), params=params, timeout=30)
        r.raise_for_status()
        data = r.json()
        records.extend(data.get("records", []))
        if "offset" not in data:
            return records
        params["offset"] = data["offset"]


def patch_records(table_id, records):
    """PATCH records ([{"id": ..., "fields": {...}}]) in Airtable's max-10 batches."""
    for i in range(0, len(records), 10):
        r = requests.patch(f"{_api()}/{table_id}", headers=_headers(),
                           json={"records": records[i:i + 10]}, timeout=30)
        r.raise_for_status()
