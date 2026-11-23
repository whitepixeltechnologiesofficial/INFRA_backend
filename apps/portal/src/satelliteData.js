import { supabase, supabaseConfigured, supabaseError } from './supabaseClient.js';
import {
  PORTAL_VIEWS,
  STORAGE_FILES,
  parseBounds,
  resolveSceneId,
  resolveStorageBuckets,
  sameZoneKey,
  zoneKeyFromFeature,
  zoneKeyFromZone,
} from './portalContract.js';

const BUCKETS = resolveStorageBuckets(import.meta.env.VITE_SATELLITE_BUCKETS);
export const SATELLITE_FILE_KEYS = Object.freeze(Object.keys(STORAGE_FILES));

function configurationMessage() {
  if (supabaseConfigured) return null;
  return supabaseError || 'Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.';
}

function publicFileUrl(bucket, path) {
  if (!supabase || !bucket || !path) return null;
  return supabase.storage.from(bucket).getPublicUrl(path).data?.publicUrl || null;
}

async function fetchJson(url, label) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status} ${response.statusText}`);
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${label}: invalid JSON (${error.message})`);
  }
}

export async function findPublicFile(key) {
  const paths = STORAGE_FILES[key] || [];
  const attempts = [];
  for (const bucket of BUCKETS) {
    for (const path of paths) {
      const url = publicFileUrl(bucket, path);
      if (!url) continue;
      try {
        const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
        if (response.ok) return { key, bucket, path, url, attempts };
        attempts.push(`${bucket}/${path}: HTTP ${response.status}`);
      } catch (error) {
        attempts.push(`${bucket}/${path}: ${error.message}`);
      }
    }
  }
  return { key, bucket: null, path: null, url: null, attempts };
}

function normalizeGeoJson(data) {
  if (data?.geojson?.type !== 'FeatureCollection') return null;
  return {
    type: 'FeatureCollection',
    features: (data.geojson.features || []).map((feature) => ({
      ...feature,
      properties: { ...(feature.properties || {}), zone_key: zoneKeyFromFeature(feature) },
    })),
  };
}

function geometryForZone(zone) {
  if (!zone?.geometry) return null;
  if (typeof zone.geometry !== 'string') return zone.geometry;
  try {
    return JSON.parse(zone.geometry);
  } catch {
    return null;
  }
}

export async function loadSatelliteData() {
  const configProblem = configurationMessage();
  if (configProblem) throw new Error(configProblem);

  const [sceneResult, zonesResult] = await Promise.all([
    supabase.from(PORTAL_VIEWS.scenes.name).select('*').order('acquired_at', { ascending: false }).limit(1),
    supabase.from(PORTAL_VIEWS.zones.name).select('*').order('name'),
  ]);
  if (sceneResult.error) throw new Error(`${PORTAL_VIEWS.scenes.name}: ${sceneResult.error.message}`);
  if (zonesResult.error) throw new Error(`${PORTAL_VIEWS.zones.name}: ${zonesResult.error.message}`);

  const scene = sceneResult.data?.[0] || null;
  const zones = zonesResult.data || [];
  const zoneKeys = zones.map((zone) => zoneKeyFromZone(zone)).filter(Boolean);
  const sceneId = resolveSceneId(scene);
  const issues = [];

  if (sceneId === null) {
    issues.push({ level: 'warning', type: 'scene', message: 'The latest scene has no resolvable id, so model metrics could not be loaded.' });
  }

  const emptyResult = { data: [], error: null };
  const [driversResult, contributionsResult, scenariosResult, metricsResult] = await Promise.all([
    zoneKeys.length ? supabase.from(PORTAL_VIEWS.drivers.name).select('*').in('zone_id', zoneKeys) : Promise.resolve(emptyResult),
    zoneKeys.length ? supabase.from(PORTAL_VIEWS.contributions.name).select('*').in('zone_id', zoneKeys) : Promise.resolve(emptyResult),
    zoneKeys.length ? supabase.from(PORTAL_VIEWS.scenarios.name).select('*').in('zone_id', zoneKeys).order('rank') : Promise.resolve(emptyResult),
    sceneId ? supabase.from(PORTAL_VIEWS.metrics.name).select('*').eq('scene_id', sceneId).limit(1) : Promise.resolve(emptyResult),
  ]);

  for (const [name, result] of [
    [PORTAL_VIEWS.drivers.name, driversResult],
    [PORTAL_VIEWS.contributions.name, contributionsResult],
    [PORTAL_VIEWS.scenarios.name, scenariosResult],
    [PORTAL_VIEWS.metrics.name, metricsResult],
  ]) {
    if (result.error) throw new Error(`${name}: ${result.error.message}`);
  }

  for (const zone of zones) {
    if (zone.geometry && geometryForZone(zone) === null) {
      issues.push({ level: 'error', type: 'geojson', message: `Stored geometry for zone ${zoneKeyFromZone(zone) || 'unknown'} is invalid and was skipped.` });
    }
  }

  const files = {};
  for (const key of SATELLITE_FILE_KEYS) {
    const result = await findPublicFile(key);
    files[key] = result.url ? { bucket: result.bucket, path: result.path, url: result.url } : null;
    if (!result.url) {
      issues.push({
        level: 'warning',
        type: 'storage',
        message: `No configured object found for ${key}. Tried: ${result.attempts.join('; ') || 'no bucket/path combinations'}.`,
      });
    }
  }

  let bounds = null;
  if (files.bounds?.url) {
    try {
      bounds = parseBounds(await fetchJson(files.bounds.url, 'heatmap_bounds.json'));
    } catch (error) {
      issues.push({ level: 'error', type: 'bounds', message: error.message });
    }
  }

  let geojson = null;
  if (files.zones?.url) {
    try {
      geojson = await fetchJson(files.zones.url, 'zones.geojson');
      if (geojson?.type !== 'FeatureCollection') throw new Error('expected a FeatureCollection');
    } catch (error) {
      issues.push({ level: 'error', type: 'geojson', message: `zones.geojson could not be used: ${error.message}` });
      geojson = null;
    }
  }

  return {
    scene,
    zones,
    drivers: driversResult.data || [],
    contributions: contributionsResult.data || [],
    scenarios: scenariosResult.data || [],
    metrics: metricsResult.data?.[0] || null,
    files,
    bounds,
    geojson: normalizeGeoJson({ geojson }),
    issues,
  };
}

export function zoneFeatureCollection(data) {
  const normalizedGeoJson = normalizeGeoJson(data);
  if (normalizedGeoJson) return normalizedGeoJson;
  return {
    type: 'FeatureCollection',
    features: (data?.zones || []).map((zone) => {
      const geometry = geometryForZone(zone);
      if (!geometry) return null;
      return {
        type: 'Feature',
        geometry,
        properties: { ...zone, geometry: undefined, zone_key: zoneKeyFromZone(zone) },
      };
    }).filter(Boolean),
  };
}

export function zoneIdFromFeature(feature) {
  return zoneKeyFromFeature(feature);
}

export function zoneIdFromZone(zone) {
  return zoneKeyFromZone(zone);
}

export function formatSceneDate(scene) {
  if (!scene?.acquired_at) return 'Scene date unavailable';
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(scene.acquired_at));
}

export function driverRows(zoneId, drivers, contributions) {
  const driver = (drivers || []).find((row) => sameZoneKey(row.zone_id, zoneId));
  const rows = (contributions || []).filter((row) => sameZoneKey(row.zone_id, zoneId))
    .sort((a, b) => Number(b.contribution_pct || 0) - Number(a.contribution_pct || 0));
  return { driver, contributions: rows };
}

export function scenarioRows(zoneId, scenarios) {
  return (scenarios || []).filter((row) => sameZoneKey(row.zone_id, zoneId))
    .sort((a, b) => Number(a.rank ?? 999) - Number(b.rank ?? 999));
}
