"""BigQuery reference pack: the data.warehouse.* prefix family.

Self-registers at import time (the loader imports packs after Protocol
validation). Read-only GoogleSQL access with dry-run cost previews.
"""
from charter.sdk import register_prefix, summary
from charter.packs.bigquery import warehouse_query

name = "bigquery"

register_prefix("data.warehouse.", warehouse_query.run, {
    "summary": summary(warehouse_query.run),
    "detail": "call data.warehouse.schema for the dataset/table catalog + analyst "
              "guide, then data.warehouse.query with a GoogleSQL SELECT "
              "(read-only enforced, 5k-row / 2 GiB caps, dry_run:true to preview cost)",
    "read": True, "scope": "data.warehouse.query"})
