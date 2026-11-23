export const PORTAL_VIEWS = Object.freeze({
  scenes: Object.freeze({ name: 'scenes_portal', fields: Object.freeze(['id', 'satellite', 'acquired_at', 'cloud_cover_pct', 'flagged', 'source']) }),
  zones: Object.freeze({ name: 'zones_portal', fields: Object.freeze(['id', 'zone_id', 'name', 'category', 'mean_lst_c', 'geometry']) }),
  drivers: Object.freeze({ name: 'zone_drivers_portal', fields: Object.freeze(['zone_id', 'ndvi', 'albedo', 'building_density', 'water_distance_m']) }),
  contributions: Object.freeze({ name: 'zone_contributions_portal', fields: Object.freeze(['zone_id', 'driver', 'contribution_pct', 'direction']) }),
  scenarios: Object.freeze({ name: 'scenario_results_portal', fields: Object.freeze(['zone_id', 'intervention', 'est_reduction_c', 'flag', 'rank']) }),
  metrics: Object.freeze({ name: 'model_metrics_portal', fields: Object.freeze(['scene_id', 'r2_score', 'mae_celsius']) }),
});

export const DEFAULT_SATELLITE_BUCKETS = Object.freeze([
  'heat-shield-files',
  'satellite-results',
  'satellite',
  'heat-shield',
  'heatmap',
]);

export const STORAGE_FILES = Object.freeze({
  heatmap: Object.freeze(['heatmap.png']),
  bounds: Object.freeze(['heatmap_bounds.json']),
  zones: Object.freeze(['zones.geojson']),
  trees: Object.freeze(['scenario_trees.png', 'trees.png']),
  roofs: Object.freeze(['scenario_roofs.png', 'cool_roofs.png']),
  water: Object.freeze(['scenario_water.png', 'water_bodies.png']),
});

function scalarKey(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  return null;
}

export function resolveStorageBuckets(raw) {
  const fromEnv = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  const buckets = fromEnv.map((bucket) => String(bucket || '').trim()).filter(Boolean);
  const resolved = buckets.length ? buckets : [...DEFAULT_SATELLITE_BUCKETS];
  return [...new Set(resolved)];
}

export function storagePathsFor(key) {
  return [...(STORAGE_FILES[key] || [])];
}

export function resolveSceneId(scene) {
  return scalarKey(scene?.id) || scalarKey(scene?.scene_id) || null;
}

export function normalizeZoneKey(value) {
  if (value && typeof value === 'object') {
    return scalarKey(value.zone_key)
      || scalarKey(value.properties?.zone_key)
      || scalarKey(value.zone_id)
      || scalarKey(value.properties?.zone_id)
      || scalarKey(value.id)
      || scalarKey(value.properties?.id)
      || null;
  }
  return scalarKey(value);
}

export function zoneKeyFromZone(zone) {
  return scalarKey(zone?.zone_id) || scalarKey(zone?.id) || null;
}

export function zoneKeyFromFeature(feature) {
  return scalarKey(feature?.properties?.zone_key)
    || scalarKey(feature?.properties?.zone_id)
    || scalarKey(feature?.properties?.id)
    || scalarKey(feature?.zone_key)
    || scalarKey(feature?.id)
    || null;
}

export function sameZoneKey(left, right) {
  const a = normalizeZoneKey(left);
  const b = normalizeZoneKey(right);
  return a !== null && b !== null && a === b;
}

function finiteNumber(value, label) {
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) {
    throw new Error(`BOUNDS_INVALID: ${label} is not a finite number`);
  }
  return number;
}

export function parseBounds(input) {
  let south;
  let west;
  let north;
  let east;

  if (Array.isArray(input) && input.length === 2 && Array.isArray(input[0]) && Array.isArray(input[1]) && input[0].length === 2 && input[1].length === 2) {
    [south, west] = [finiteNumber(input[0][0], 'south'), finiteNumber(input[0][1], 'west')];
    [north, east] = [finiteNumber(input[1][0], 'north'), finiteNumber(input[1][1], 'east')];
  } else if (input && typeof input === 'object') {
    if (input.south !== undefined || input.west !== undefined || input.north !== undefined || input.east !== undefined) {
      south = finiteNumber(input.south, 'south');
      west = finiteNumber(input.west, 'west');
      north = finiteNumber(input.north, 'north');
      east = finiteNumber(input.east, 'east');
    } else if (input.min_lat !== undefined || input.min_lon !== undefined || input.max_lat !== undefined || input.max_lon !== undefined) {
      south = finiteNumber(input.min_lat, 'min_lat');
      west = finiteNumber(input.min_lon, 'min_lon');
      north = finiteNumber(input.max_lat, 'max_lat');
      east = finiteNumber(input.max_lon, 'max_lon');
    } else if (input.minx !== undefined || input.miny !== undefined || input.maxx !== undefined || input.maxy !== undefined) {
      south = finiteNumber(input.miny, 'miny');
      west = finiteNumber(input.minx, 'minx');
      north = finiteNumber(input.maxy, 'maxy');
      east = finiteNumber(input.maxx, 'maxx');
    } else {
      throw new Error('BOUNDS_INVALID: unsupported bounds object');
    }
  } else {
    throw new Error('BOUNDS_INVALID: unsupported bounds format');
  }

  if (south < -90 || south > 90 || north < -90 || north > 90) {
    throw new Error('BOUNDS_INVALID: latitude outside -90..90');
  }
  if (west < -180 || west > 180 || east < -180 || east > 180) {
    throw new Error('BOUNDS_INVALID: longitude outside -180..180');
  }
  if (south >= north || west >= east) {
    throw new Error('BOUNDS_INVALID: bounds must have increasing latitude and longitude');
  }

  return [[south, west], [north, east]];
}
