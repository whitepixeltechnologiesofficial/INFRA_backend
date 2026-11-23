import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PORTAL_VIEWS,
  STORAGE_FILES,
  normalizeZoneKey,
  parseBounds,
  resolveSceneId,
  resolveStorageBuckets,
  sameZoneKey,
  storagePathsFor,
  zoneKeyFromFeature,
  zoneKeyFromZone,
} from '../src/portalContract.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${label}: ${error.message}`);
  }
}

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function includes(relativePath, text) {
  return read(relativePath).includes(text);
}

check('portal view names', () => {
  assert.deepEqual(Object.values(PORTAL_VIEWS).map((view) => view.name), [
    'scenes_portal',
    'zones_portal',
    'zone_drivers_portal',
    'zone_contributions_portal',
    'scenario_results_portal',
    'model_metrics_portal',
  ]);
});

check('default storage buckets include heat-shield-files', () => {
  assert.deepEqual(resolveStorageBuckets(''), ['heat-shield-files', 'satellite-results', 'satellite', 'heat-shield', 'heatmap']);
});

check('storage buckets dedupe and preserve order', () => {
  assert.deepEqual(resolveStorageBuckets('satellite-results, heat-shield-files, satellite-results'), ['satellite-results', 'heat-shield-files']);
});

check('storage bucket array input', () => {
  assert.deepEqual(resolveStorageBuckets(['satellite', 'heatmap']), ['satellite', 'heatmap']);
});

check('storage filename variants', () => {
  assert.deepEqual(storagePathsFor('trees'), ['scenario_trees.png', 'trees.png']);
  assert.deepEqual(storagePathsFor('roofs'), ['scenario_roofs.png', 'cool_roofs.png']);
  assert.deepEqual(storagePathsFor('water'), ['scenario_water.png', 'water_bodies.png']);
  assert.deepEqual(Object.keys(STORAGE_FILES), ['heatmap', 'bounds', 'zones', 'trees', 'roofs', 'water']);
});

check('scene id resolves id then scene_id', () => {
  assert.equal(resolveSceneId({ id: 'scene-1', scene_id: 'legacy' }), 'scene-1');
  assert.equal(resolveSceneId({ scene_id: 'legacy' }), 'legacy');
  assert.equal(resolveSceneId(null), null);
});

check('zone keys resolve from zone rows', () => {
  assert.equal(zoneKeyFromZone({ zone_id: 'Z-1', id: 'other' }), 'Z-1');
  assert.equal(zoneKeyFromZone({ id: 42 }), '42');
  assert.equal(zoneKeyFromZone(null), null);
});

check('zone keys resolve from feature properties', () => {
  assert.equal(zoneKeyFromFeature({ properties: { zone_key: 'Z-1', zone_id: 'Z-2' } }), 'Z-1');
  assert.equal(zoneKeyFromFeature({ properties: { zone_id: 'Z-2' } }), 'Z-2');
  assert.equal(zoneKeyFromFeature({ properties: { id: 42 } }), '42');
  assert.equal(zoneKeyFromFeature(null), null);
});

check('normalizeZoneKey accepts objects and scalars', () => {
  assert.equal(normalizeZoneKey({ id: 'Z-1' }), 'Z-1');
  assert.equal(normalizeZoneKey(42), '42');
  assert.equal(normalizeZoneKey('  Z-1  '), 'Z-1');
});

check('sameZoneKey normalizes number and string ids', () => {
  assert.equal(sameZoneKey({ zone_id: 42 }, '42'), true);
  assert.equal(sameZoneKey({ id: 'Z-1' }, { zone_id: 'Z-1' }), true);
  assert.equal(sameZoneKey(null, 'Z-1'), false);
  assert.equal(sameZoneKey('Z-1', 'Z-2'), false);
});

check('parseBounds supports leaflet array format', () => {
  assert.deepEqual(parseBounds([[9.9, 78.1], [10.1, 78.3]]), [[9.9, 78.1], [10.1, 78.3]]);
});

check('parseBounds supports south/west/north/east', () => {
  assert.deepEqual(parseBounds({ south: 9.9, west: 78.1, north: 10.1, east: 78.3 }), [[9.9, 78.1], [10.1, 78.3]]);
});

check('parseBounds supports min_lat/min_lon/max_lat/max_lon', () => {
  assert.deepEqual(parseBounds({ min_lat: 9.9, min_lon: 78.1, max_lat: 10.1, max_lon: 78.3 }), [[9.9, 78.1], [10.1, 78.3]]);
});

check('parseBounds supports migration minx/miny/maxx/maxy', () => {
  assert.deepEqual(parseBounds({ minx: 78.1, miny: 9.9, maxx: 78.3, maxy: 10.1 }), [[9.9, 78.1], [10.1, 78.3]]);
});

check('parseBounds rejects invalid ranges', () => {
  assert.throws(() => parseBounds({ south: 10, west: 78, north: 9, east: 79 }), /BOUNDS_INVALID/);
  assert.throws(() => parseBounds({ south: -91, west: 78, north: 9, east: 79 }), /BOUNDS_INVALID/);
  assert.throws(() => parseBounds({}), /BOUNDS_INVALID/);
});

check('satelliteData uses portal views', () => {
  for (const view of Object.values(PORTAL_VIEWS).map((item) => item.name)) {
    assert.ok(includes('src/satelliteData.js', `PORTAL_VIEWS.${Object.keys(PORTAL_VIEWS).find((key) => PORTAL_VIEWS[key].name === view)}.name`));
  }
});

check('satelliteData resolves scene id before metrics query', () => {
  assert.ok(includes('src/satelliteData.js', 'const sceneId = resolveSceneId(scene);'));
  assert.ok(includes('src/satelliteData.js', "eq('scene_id', sceneId)"));
  assert.ok(!includes('src/satelliteData.js', 'sceneResult.data?.[0]?.scene_id'));
});

check('satelliteData records storage, bounds, geojson and scene issues', () => {
  const source = read('src/satelliteData.js');
  for (const type of ["type: 'scene'", "type: 'storage'", "type: 'bounds'", "type: 'geojson'"]) {
    assert.ok(source.includes(type), `missing ${type}`);
  }
  assert.ok(!source.includes('catch (_) {}'));
});

check('satelliteData uses config error from client', () => {
  assert.ok(includes('src/satelliteData.js', "import { supabase, supabaseConfigured, supabaseError } from './supabaseClient.js';"));
  assert.ok(includes('src/satelliteData.js', 'return supabaseError ||'));
});

check('DataCredits has no base-table queries or static scene fallback', () => {
  const source = read('src/screens/DataCredits.jsx');
  assert.ok(!source.includes("from('scenes')"));
  assert.ok(!source.includes("from('model_metrics')"));
  assert.ok(!source.includes('SCENE_INFO'));
  assert.ok(source.includes('useSatelliteData'));
});

check('all Step 30 screens render loading, error and empty states', () => {
  for (const file of ['HeatMap.jsx', 'CoolingSimulator.jsx', 'Recommendations.jsx', 'AreaSummary.jsx', 'DataCredits.jsx']) {
    const source = read(`src/screens/${file}`);
    assert.ok(source.includes('DataLoading'), `${file} missing DataLoading`);
    assert.ok(source.includes('DataError'), `${file} missing DataError`);
    assert.ok(source.includes('DataEmpty'), `${file} missing DataEmpty`);
    assert.ok(source.includes('IssuesPanel'), `${file} missing IssuesPanel`);
  }
});

check('zone key normalization is used by scenario screens', () => {
  assert.ok(includes('src/screens/CoolingSimulator.jsx', 'sameZoneKey'));
  assert.ok(includes('src/screens/Recommendations.jsx', 'sameZoneKey'));
  assert.ok(includes('src/screens/AreaSummary.jsx', 'sameZoneKey'));
  assert.ok(includes('src/screens/HeatMap.jsx', 'sameZoneKey'));
});

check('global config warning is mounted', () => {
  assert.ok(includes('src/App.jsx', 'ConfigWarning'));
  assert.ok(includes('src/App.jsx', 'supabaseConfigured'));
});

check('package scripts include tests', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.test, 'node scripts/verify-step30.mjs');
  assert.equal(pkg.scripts.verify, 'node scripts/verify-step30.mjs');
});

check('env example includes heat-shield-files bucket', () => {
  assert.ok(includes('.env.example', 'VITE_SATELLITE_BUCKETS=heat-shield-files,'));
});

check('README documents portal views and filename fallbacks', () => {
  const source = read('README.md');
  assert.ok(source.includes('scenes_portal'));
  assert.ok(source.includes('model_metrics_portal'));
  assert.ok(source.includes('scenario_trees.png'));
  assert.ok(source.includes('trees.png'));
});

check('tsconfig does not inherit root expo config', () => {
  const config = JSON.parse(read('tsconfig.json'));
  assert.equal(config.extends, undefined);
  assert.ok(config.compilerOptions.types.includes('vite/client'));
});

check('proposed SQL is outside active migrations directory', () => {
  const source = read('supabase/PROPOSED_20241007000001_zone_contributions.sql');
  assert.ok(source.includes('ADD COLUMN IF NOT EXISTS driver text'));
  assert.ok(source.includes('CREATE VIEW zone_contributions_portal'));
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
