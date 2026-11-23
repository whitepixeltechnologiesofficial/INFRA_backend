# Task 30 + Task 31 completion notes

## Task 30 — Satellite + Portal

Implemented the portal-side live satellite data path using the PRD satellite model:

- `scenes`
- `zones`
- `zone_drivers`
- `zone_contributions`
- `scenario_results`
- `model_metrics`

The Heat Map no longer generates a synthetic 100 m temperature grid. It uses stored zone geometry and the real `heatmap.png` / `heatmap_bounds.json` Storage export when available. Area Detail reads the live driver/contribution rows. Cooling Simulator and Recommendations read `scenario_results`.

The portal also searches configured public satellite Storage buckets for the agreed exports: `heatmap.png`, `heatmap_bounds.json`, `zones.geojson`, and the three scenario overlays.

## Task 31 — Station + Portal

The Live Stations screen now:

- loads station records from `stations`;
- loads active alerts from `alerts`;
- listens for live `readings` inserts through Supabase Realtime;
- listens for live `alerts` changes;
- shows alert/break state from the active alert record;
- records a portal break confirmation against the open alert when the configured demo/site PIN is accepted.

The existing station simulator remains compatible with the portal. It sends the agreed `ingest-reading` payload and supports manual/automatic break and motion testing.

## Important validation status

Source changes were completed and packaged. A full browser/Supabase live run could not be executed in this build environment because the Supabase host was not network-resolvable here and the uploaded ZIP did not contain a complete Vite toolchain. Therefore the final live acceptance checks must be run against the team's Supabase/Vercel environment before calling the deployment independently verified.
