-- D1 twin of audit_table.sql. Apply: npx wrangler d1 execute charter-audit --remote --file ../sql/audit_table.d1.sql
CREATE TABLE IF NOT EXISTS audit (
  ts TEXT NOT NULL, actor TEXT, interface TEXT, verb TEXT, target TEXT, result TEXT,
  detail TEXT, request_id TEXT, on_behalf_of TEXT, credential TEXT, traceparent TEXT
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts);
-- Identification maps (cloudflare mode): one JSON row each, name = 'keys' | 'grants'.
-- Written by `charter keys` / `charter grants push`; read by the core every 60 s.
CREATE TABLE IF NOT EXISTS config (name TEXT PRIMARY KEY, value TEXT NOT NULL);
