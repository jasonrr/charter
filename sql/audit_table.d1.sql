-- D1 twin of audit_table.sql. Apply: npx wrangler d1 execute charter-audit --remote --file ../sql/audit_table.d1.sql
CREATE TABLE IF NOT EXISTS audit (
  ts TEXT NOT NULL, actor TEXT, interface TEXT, verb TEXT, target TEXT, result TEXT,
  detail TEXT, request_id TEXT, on_behalf_of TEXT, credential TEXT, traceparent TEXT
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts);
