-- ============================================================
-- COMPLETE PORTAL DATABASE SETUP
-- Run order: 1. Base schema, 2. Missing tables/columns, 3. Data population, 4. Portal views
-- ============================================================

-- Enable PostGIS
CREATE EXTENSION IF NOT EXISTS postgis;

-- ============================================================
-- 1. BASE TABLES (from db_schema.sql)
-- ============================================================

-- Zones reference table
CREATE TABLE IF NOT EXISTS zones (
    zone_id         TEXT PRIMARY KEY,
    zone_name       TEXT,
    geom            GEOMETRY(POLYGON, 4326),
    centroid        GEOMETRY(POINT, 4326),
    is_hot          BOOLEAN,
    cell_count      INTEGER,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zones_geom ON zones USING GIST(geom);

-- Cell features (output of Task 6)
CREATE TABLE IF NOT EXISTS cell_features (
    id              BIGSERIAL PRIMARY KEY,
    cell_id         TEXT NOT NULL,
    zone_id         TEXT NOT NULL REFERENCES zones(zone_id),
    geom            GEOMETRY(POINT, 4326),
    temperature_c   NUMERIC(5,2),
    ndvi            NUMERIC(4,3),
    ndwi            NUMERIC(4,3),
    albedo          NUMERIC(4,3),
    lc_trees        NUMERIC(4,3),
    lc_grass        NUMERIC(4,3),
    lc_crops        NUMERIC(4,3),
    lc_builtup      NUMERIC(4,3),
    lc_bare         NUMERIC(4,3),
    lc_water        NUMERIC(4,3),
    building_density NUMERIC(4,3),
    dist_to_water_m  NUMERIC(8,1),
    is_cloud        BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cell_features_zone ON cell_features(zone_id);
CREATE INDEX IF NOT EXISTS idx_cell_features_geom ON cell_features USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_cell_features_cell_id ON cell_features(cell_id);

-- Model metrics (output of Task 7)
CREATE TABLE IF NOT EXISTS model_metrics (
    id              BIGSERIAL PRIMARY KEY,
    model_version   TEXT NOT NULL,
    train_zones     TEXT[] NOT NULL,
    test_zones      TEXT[] NOT NULL,
    r2_score        NUMERIC(5,4),
    mae_celsius     NUMERIC(5,2),
    rmse_celsius    NUMERIC(5,2),
    n_train_cells   INTEGER,
    n_test_cells    INTEGER,
    feature_importance JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_model_metrics_version ON model_metrics(model_version);

-- Zone contributions / SHAP explanations (output of Task 5)
CREATE TABLE IF NOT EXISTS zone_contributions (
    id              BIGSERIAL PRIMARY KEY,
    zone_id         TEXT NOT NULL REFERENCES zones(zone_id),
    zone_name       TEXT,
    is_hot_zone     BOOLEAN NOT NULL,
    cause_1         TEXT NOT NULL,
    cause_1_pct     NUMERIC(5,2),
    cause_2         TEXT,
    cause_2_pct     NUMERIC(5,2),
    cause_3         TEXT,
    cause_3_pct     NUMERIC(5,2),
    model_version   TEXT REFERENCES model_metrics(model_version),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_zone_contributions_zone_model 
    ON zone_contributions(zone_id, model_version);

-- Cooling scenario results (output of Task 9)
CREATE TABLE IF NOT EXISTS scenario_results (
    id              BIGSERIAL PRIMARY KEY,
    zone_id         TEXT NOT NULL REFERENCES zones(zone_id),
    scenario        TEXT NOT NULL,  -- 'trees', 'cool_roofs', 'water_bodies'
    temp_change_c   NUMERIC(5,2),   -- negative = cooling
    rank            INTEGER,
    suitability     TEXT,           -- 'suitable', 'not_suitable', 'little_benefit', 'outside_range'
    model_version   TEXT REFERENCES model_metrics(model_version),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_scenario_results_zone_scenario_model
    ON scenario_results(zone_id, scenario, model_version);

-- Heat map metadata (output of Task 1)
CREATE TABLE IF NOT EXISTS heat_map_metadata (
    id              BIGSERIAL PRIMARY KEY,
    scene_date      DATE NOT NULL,
    scene_id        TEXT NOT NULL,
    cloud_pct       NUMERIC(5,2),
    city_mean_temp_c NUMERIC(5,2),
    city_std_temp_c  NUMERIC(5,2),
    bounds          JSONB,          -- {minx, miny, maxx, maxy} in EPSG:4326
    model_version   TEXT REFERENCES model_metrics(model_version),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_heat_map_scene ON heat_map_metadata(scene_id);

-- ============================================================
-- 2. MISSING TABLES NEEDED BY PORTAL VIEWS
-- ============================================================

-- Scenes table (referenced by portal view)
CREATE TABLE IF NOT EXISTS scenes (
    id              TEXT PRIMARY KEY,
    satellite       TEXT,
    acquired_at     TIMESTAMPTZ,
    cloud_cover_pct NUMERIC(5,2),
    coverage_pct    NUMERIC(5,2),
    flagged         BOOLEAN DEFAULT FALSE,
    source          TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Zone drivers table (referenced by portal view)
CREATE TABLE IF NOT EXISTS zone_drivers (
    zone_id         TEXT PRIMARY KEY REFERENCES zones(zone_id),
    ndvi            NUMERIC(4,3),
    albedo          NUMERIC(4,3),
    building_density NUMERIC(4,3),
    water_distance_m NUMERIC(8,1),
    landcover_mix   JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Add missing columns to zones table for portal view
ALTER TABLE zones ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE zones ADD COLUMN IF NOT EXISTS type TEXT;
ALTER TABLE zones ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE zones ADD COLUMN IF NOT EXISTS mean_lst_c NUMERIC(5,2);
ALTER TABLE zones ADD COLUMN IF NOT EXISTS delta_from_mean_c NUMERIC(5,2);
ALTER TABLE zones ADD COLUMN IF NOT EXISTS confidence NUMERIC(3,2);

-- ============================================================
-- 3. POPULATE COMPUTED COLUMNS (from fix_task14.sql)
-- ============================================================

-- Fill zones.name, category, mean_lst_c, delta_from_mean_c, confidence, type
WITH zone_stats AS (
    SELECT 
        cf.zone_id,
        AVG(cf.temperature_c) AS mean_lst_c,
        COUNT(*) AS cell_count
    FROM cell_features cf
    WHERE cf.temperature_c IS NOT NULL 
      AND cf.is_cloud = false
    GROUP BY cf.zone_id
),
city_stats AS (
    SELECT 
        city_mean_temp_c,
        city_std_temp_c
    FROM heat_map_metadata
    LIMIT 1
)
UPDATE zones z
SET 
    name = z.zone_id,
    mean_lst_c = zs.mean_lst_c,
    delta_from_mean_c = zs.mean_lst_c - cs.city_mean_temp_c,
    category = CASE
        WHEN (zs.mean_lst_c - cs.city_mean_temp_c) / cs.city_std_temp_c < -1 THEN 'Cool'
        WHEN (zs.mean_lst_c - cs.city_mean_temp_c) / cs.city_std_temp_c < 0 THEN 'Moderate'
        WHEN (zs.mean_lst_c - cs.city_mean_temp_c) / cs.city_std_temp_c < 1 THEN 'Hot'
        WHEN (zs.mean_lst_c - cs.city_mean_temp_c) / cs.city_std_temp_c < 2 THEN 'Very Hot'
        ELSE 'Extreme'
    END,
    confidence = CASE
        WHEN zs.cell_count >= 50 THEN 0.9
        WHEN zs.cell_count >= 20 THEN 0.7
        ELSE 0.5
    END
FROM zone_stats zs, city_stats cs
WHERE z.zone_id = zs.zone_id;

-- Also update type column (synonym for category)
UPDATE zones SET type = category WHERE type IS NULL;

-- Fill scenes table (from heat_map_metadata)
INSERT INTO scenes (id, satellite, acquired_at, cloud_cover_pct, coverage_pct, flagged, source)
SELECT 
    scene_id,
    'Landsat 8',
    scene_date::timestamptz,
    cloud_pct,
    100.0,
    false,
    'Microsoft Planetary Computer'
FROM heat_map_metadata
WHERE scene_id IS NOT NULL
ON CONFLICT (id) DO UPDATE SET
    cloud_cover_pct = EXCLUDED.cloud_cover_pct,
    acquired_at = EXCLUDED.acquired_at;

-- Fill zone_drivers (aggregate cell_features per zone)
INSERT INTO zone_drivers (zone_id, ndvi, albedo, building_density, water_distance_m, landcover_mix)
SELECT 
    cf.zone_id,
    AVG(cf.ndvi) AS ndvi,
    AVG(cf.albedo) AS albedo,
    AVG(cf.building_density) AS building_density,
    AVG(cf.dist_to_water_m) AS water_distance_m,
    jsonb_build_object(
        'trees', AVG(cf.lc_trees),
        'grass', AVG(cf.lc_grass),
        'crops', AVG(cf.lc_crops),
        'builtup', AVG(cf.lc_builtup),
        'bare', AVG(cf.lc_bare),
        'water', AVG(cf.lc_water)
    ) AS landcover_mix
FROM cell_features cf
WHERE cf.temperature_c IS NOT NULL
  AND cf.is_cloud = false
GROUP BY cf.zone_id
ON CONFLICT (zone_id) DO UPDATE SET
    ndvi = EXCLUDED.ndvi,
    albedo = EXCLUDED.albedo,
    building_density = EXCLUDED.building_density,
    water_distance_m = EXCLUDED.water_distance_m,
    landcover_mix = EXCLUDED.landcover_mix;

-- Populate zone_contributions new columns
UPDATE zone_contributions zc
SET 
    driver = zc.cause_1,
    contribution_pct = zc.cause_1_pct,
    direction = CASE 
        WHEN zc.is_hot_zone THEN 'heating'
        ELSE 'cooling'
    END
WHERE zc.driver IS NULL;

-- ============================================================
-- 4. PORTAL VIEWS (from portal_views.sql)
-- ============================================================

-- Drop existing views first (CREATE OR REPLACE fails when columns change)
DROP VIEW IF EXISTS scenario_results_portal CASCADE;
DROP VIEW IF EXISTS model_metrics_portal CASCADE;
DROP VIEW IF EXISTS zones_portal CASCADE;
DROP VIEW IF EXISTS zone_drivers_portal CASCADE;
DROP VIEW IF EXISTS zone_contributions_portal CASCADE;
DROP VIEW IF EXISTS scenes_portal CASCADE;

-- 1. Scenario Results View (portal expects intervention, est_reduction_c, flag)
CREATE VIEW scenario_results_portal AS
SELECT
    zone_id,
    CASE 
        WHEN scenario = 'trees' THEN 'trees'
        WHEN scenario = 'cool_roofs' THEN 'roofs'
        WHEN scenario = 'water_bodies' THEN 'water'
        ELSE scenario
    END AS intervention,
    -temp_change_c AS est_reduction_c,  -- portal expects positive = cooling
    CASE 
        WHEN suitability = 'not_suitable' THEN 'not_suitable'
        WHEN suitability = 'little_benefit' THEN 'low_benefit'
        WHEN suitability = 'outside_range' THEN 'out_of_range'
        WHEN suitability = 'suitable' THEN 'none'
        ELSE 'none'
    END AS flag,
    rank,
    scenario,
    temp_change_c,
    suitability,
    model_version,
    created_at
FROM scenario_results;

-- 2. Model Metrics View (portal expects scene_id)
CREATE VIEW model_metrics_portal AS
SELECT
    id,
    model_version AS scene_id,  -- use model_version as scene_id for portal
    train_zones,
    test_zones,
    r2_score,
    mae_celsius,
    rmse_celsius,
    n_train_cells,
    n_test_cells,
    feature_importance,
    created_at
FROM model_metrics;

-- 3. Zones View with geometry as JSON (portal expects GeoJSON geometry)
CREATE VIEW zones_portal AS
SELECT
    zone_id AS id,
    zone_id,
    name,
    type,
    category,
    mean_lst_c,
    delta_from_mean_c,
    confidence,
    cell_count,
    ST_AsGeoJSON(geom)::json AS geometry,
    ST_AsGeoJSON(centroid)::json AS centroid,
    is_hot,
    created_at
FROM zones;

-- 4. Zone Drivers View (ensure column names match)
CREATE VIEW zone_drivers_portal AS
SELECT
    zone_id,
    ndvi,
    albedo,
    building_density,
    water_distance_m,
    landcover_mix
FROM zone_drivers;

-- 5. Zone Contributions View (ensure new columns are used)
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

-- 6. Scenes View (ensure all fields)
CREATE VIEW scenes_portal AS
SELECT
    id,
    satellite,
    acquired_at,
    cloud_cover_pct,
    coverage_pct,
    flagged,
    source,
    created_at
FROM scenes;

-- Grant access to anon role (for portal with publishable key)
GRANT SELECT ON scenario_results_portal TO anon;
GRANT SELECT ON model_metrics_portal TO anon;
GRANT SELECT ON zones_portal TO anon;
GRANT SELECT ON zone_drivers_portal TO anon;
GRANT SELECT ON zone_contributions_portal TO anon;
GRANT SELECT ON scenes_portal TO anon;

-- ============================================================
-- 5. STORAGE BUCKET (heat-shield-files)
-- ============================================================
-- Note: Buckets must be created via Supabase Dashboard or API
-- INSERT INTO storage.buckets (id, name, public) VALUES ('heat-shield-files', 'heat-shield-files', true);
