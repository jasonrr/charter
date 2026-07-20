# Warehouse Analyst Guide

This guide helps analysts query the synced warehouse through `data.warehouse.*`.

## Datasets

Configure `WAREHOUSE_DATASETS` with the comma-separated list of datasets your
adopter wants exposed. Each dataset is a BigQuery dataset containing synced tables
from your source-of-truth systems.

## Querying

1. Call `data.warehouse.schema` to list available datasets and tables.
2. Call `data.warehouse.schema` with `{"table": "dataset.table"}` for column details.
3. Call `data.warehouse.query` with a GoogleSQL SELECT statement.

## Safety

- Only SELECT statements are allowed (enforced by BigQuery dry-run typing).
- Queries run as an impersonated service account (not the runtime's ambient credentials).
- 5,000 row / 2 GiB caps prevent runaway queries.
- Always use `dry_run:true` first to preview bytes scanned.

## Example

```json
{"verb": "data.warehouse.query", "sql": "SELECT * FROM my_dataset.my_table LIMIT 100"}
```
