# Satellite-to-Street Heat Shield — Final Portal

React + Vite + Leaflet + Supabase portal for the Satellite-to-Street Heat Shield.

## Task 30 — Satellite + Portal

The portal reads the live satellite result model through these Supabase views:

- `scenes_portal`
- `zones_portal`
- `zone_drivers_portal`
- `zone_contributions_portal`
- `scenario_results_portal`
- `model_metrics_portal`

It also loads these Supabase Storage exports when present:

- `heatmap.png`
- `heatmap_bounds.json`
- `zones.geojson`
- `scenario_trees.png` (fallback: `trees.png`)
- `scenario_roofs.png` (fallback: `cool_roofs.png`)
- `scenario_water.png` (fallback: `water_bodies.png`)

No generated/sample temperature grid is used by the Heat Map, Cooling Simulator, Recommendations, or Area Summary.

## Run

```bash
npm install
cp .env.example .env.local
# set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY
# set VITE_SATELLITE_BUCKETS to the bucket that contains the exported files
npm run dev
```

The portal expects the public key to have read access to the six `*_portal` views and the configured public Storage buckets.

## Task 30 acceptance check

1. Open Heat Map and confirm the scene metadata and zone count are loaded from Supabase.
2. Confirm the map is centred on Madurai and zone geometry aligns with the stored GeoJSON/table geometry.
3. Click three zones and compare surface temperature with `zones.mean_lst_c`.
4. Compare drivers with `zone_drivers_portal` and causes with `zone_contributions_portal`.
5. Open Cooling Simulator and compare each displayed estimate with `scenario_results_portal.est_reduction_c`.
6. Open Recommendations and compare the top three rows with `scenario_results_portal.rank`.
7. Open Data & Credits and compare the metadata with `scenes_portal` and `model_metrics_portal`.
8. If an overlay file is available, confirm `heatmap.png` uses the coordinates from `heatmap_bounds.json`.
