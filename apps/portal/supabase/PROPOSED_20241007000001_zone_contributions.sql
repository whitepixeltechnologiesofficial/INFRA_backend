ALTER TABLE zone_contributions
  ADD COLUMN IF NOT EXISTS driver text,
  ADD COLUMN IF NOT EXISTS contribution_pct numeric,
  ADD COLUMN IF NOT EXISTS direction text;

UPDATE zone_contributions zc
SET
  driver = COALESCE(zc.driver, zc.cause_1),
  contribution_pct = COALESCE(zc.contribution_pct, zc.cause_1_pct, 0),
  direction = COALESCE(zc.direction, CASE WHEN zc.is_hot_zone THEN 'heating' ELSE 'cooling' END)
WHERE zc.driver IS NULL OR zc.contribution_pct IS NULL OR zc.direction IS NULL;

DROP VIEW IF EXISTS zone_contributions_portal;

CREATE VIEW zone_contributions_portal AS
SELECT
  zone_id,
  driver,
  contribution_pct,
  direction,
  cause_1,
  cause_1_pct,
  cause_2,
  cause_2_pct,
  cause_3,
  cause_3_pct,
  model_version,
  is_hot_zone,
  created_at
FROM zone_contributions;

GRANT SELECT ON zone_contributions_portal TO anon;
