CREATE SCHEMA IF NOT EXISTS `PROJECT_ID.charter`;

CREATE TABLE IF NOT EXISTS `PROJECT_ID.charter.audit` (
  ts            TIMESTAMP NOT NULL,
  actor         STRING,
  interface     STRING,
  verb          STRING,
  target        STRING,
  result        STRING,
  detail        STRING,
  request_id    STRING,
  on_behalf_of  STRING,  -- verified human behind the caller key; NULL for machine callers
  credential    STRING   -- which credential a provider seam used ("user:<email>" or "app")
);

-- Existing deployments (one-time, additive — run before or after deploy, order-safe):
-- ALTER TABLE `PROJECT_ID.charter.audit` ADD COLUMN on_behalf_of STRING;
-- ALTER TABLE `PROJECT_ID.charter.audit` ADD COLUMN credential STRING;
