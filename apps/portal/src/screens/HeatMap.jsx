import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { MADURAI_CENTER } from './MapView.jsx';
import { useSatelliteData } from '../useSatelliteData.js';
import { driverRows, formatSceneDate, scenarioRows, zoneFeatureCollection } from '../satelliteData.js';
import { parseBounds, sameZoneKey, zoneKeyFromFeature, zoneKeyFromZone } from '../portalContract.js';
import { DataEmpty, DataError, DataLoading, IssuesPanel } from '../components/DataState.jsx';

const STYLES = {
  Cool: '#22c55e', Moderate: '#facc15', Hot: '#f97316', 'Very Hot': '#ef4444', Extreme: '#991b1b', Water: '#38bdf8', 'No data': '#94a3b8',
};

function featureStyle(feature) {
  return {
    color: '#334155',
    weight: 1,
    fillColor: STYLES[feature.properties?.category] || STYLES['No data'],
    fillOpacity: 0.5,
  };
}

function mapBoundsFromData(data) {
  if (!data?.bounds) return null;
  try {
    return parseBounds(data.bounds);
  } catch {
    return null;
  }
}

export default function HeatMap() {
  const mapNode = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const imageRef = useRef(null);
  const { data, error, loading, reload } = useSatelliteData();
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return undefined;
    const map = L.map(mapNode.current, { zoomControl: true }).setView(MADURAI_CENTER, 11);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    mapRef.current = map;
    const resizeObserver = new ResizeObserver(() => map.invalidateSize());
    resizeObserver.observe(mapNode.current);
    return () => {
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !data) return;
    layerRef.current?.remove();
    imageRef.current?.remove();
    layerRef.current = null;
    imageRef.current = null;

    const fc = zoneFeatureCollection(data);
    layerRef.current = L.geoJSON(fc, {
      style: featureStyle,
      onEachFeature: (feature, layer) => layer.on('click', () => setSelected(zoneKeyFromFeature(feature))),
    }).addTo(map);

    const bounds = mapBoundsFromData(data) || layerRef.current.getBounds();
    if (bounds?.isValid ? bounds.isValid() : bounds) map.fitBounds(bounds, { padding: [18, 18] });
    if (data.files?.heatmap?.url && bounds) {
      imageRef.current = L.imageOverlay(data.files.heatmap.url, bounds, { opacity: 0.72 }).addTo(map);
    }
  }, [data]);

  const selectedZone = useMemo(() => {
    const zones = data?.zones || [];
    return zones.find((zone) => sameZoneKey(zone, selected)) || zones[0] || null;
  }, [data, selected]);
  const selectedZoneKey = zoneKeyFromZone(selectedZone);
  const details = selectedZone ? driverRows(selectedZoneKey, data.drivers, data.contributions) : null;
  const scenarios = selectedZone ? scenarioRows(selectedZoneKey, data.scenarios) : [];

  return <section className="screen heat-screen">
    <div className="heat-toolbar">
      <div>
        <span className="eyebrow">MADURAI · REAL SATELLITE RESULTS</span>
        <h2>Surface temperature heat map</h2>
        <p>{data?.scene ? `${data.scene.satellite || 'Satellite'} · ${formatSceneDate(data.scene)}` : loading ? 'Loading satellite scene…' : 'No satellite scene available.'}</p>
      </div>
      <div className="heat-actions">
        <span className="grid-size-pill">{data?.zones?.length || 0} zones</span>
        <button className="download-btn" onClick={reload} disabled={loading}>{loading ? 'Loading…' : 'Refresh data'}</button>
      </div>
    </div>

    {loading && <DataLoading label="Loading live satellite results…" />}
    {error && <DataError title="Satellite data could not be loaded" message={error} onRetry={reload} />}
    {!loading && !error && data && <IssuesPanel issues={data.issues} />}
    {!loading && !error && data && !data.zones?.length && <DataEmpty message="No zones were returned by zones_portal." />}

    {data?.scene?.flagged && (
      <div className="cloud-warning">
        <span>☁</span>
        <div>
          <strong>Scene flagged for cloud cover</strong>
          <span>Cloud cover: {data.scene.cloud_cover_pct ?? '—'}%. Grey/no-data areas may remain in the source overlay.</span>
        </div>
      </div>
    )}

    <div className="heat-map-wrap">
      <div ref={mapNode} className="map heat-map-canvas" />
      <div className="map-info">Surface temperature from {data?.scene?.satellite || 'satellite'} · {formatSceneDate(data?.scene)} · zones from live portal views</div>
      <div className="heat-legend">
        <strong>Heat group</strong>
        {Object.keys(STYLES).map((key) => (
          <div key={key} className="legend-item">
            <span className="legend-dot" style={{ background: STYLES[key] }} />
            {key}
          </div>
        ))}
      </div>
    </div>

    {selectedZone && (
      <aside className="area-detail" aria-label="Area Detail">
        <div className="detail-head">
          <div>
            <span className="eyebrow">AREA DETAIL · LIVE DATA</span>
            <h2>{selectedZone.name}</h2>
          </div>
        </div>
        <div className="cell-location">{selectedZone.type || 'Zone'} · {selectedZone.category || 'No data'}</div>
        <div className="heat-summary compact">
          <span className="heat-badge" style={{ background: STYLES[selectedZone.category] || STYLES['No data'] }}>{selectedZone.category || 'No data'}</span>
          <strong>{Number(selectedZone.mean_lst_c).toFixed(1)}°C</strong>
          <span>{Number(selectedZone.delta_from_mean_c) >= 0 ? '+' : ''}{Number(selectedZone.delta_from_mean_c || 0).toFixed(1)}°C vs city average</span>
        </div>
        <div className="driver-grid compact-drivers">
          <div><small>Vegetation (NDVI)</small><strong>{details?.driver?.ndvi ?? '—'}</strong></div>
          <div><small>Albedo</small><strong>{details?.driver?.albedo ?? '—'}</strong></div>
          <div><small>Building density</small><strong>{details?.driver?.building_density ?? '—'}</strong></div>
          <div><small>Water distance</small><strong>{details?.driver?.water_distance_m != null ? `${details.driver.water_distance_m} m` : '—'}</strong></div>
        </div>
        <h3>Main causes / cooling factors</h3>
        {details?.contributions?.length ? (
          <ul>
            {details.contributions.slice(0, 5).map((item) => (
              <li key={`${item.zone_id}-${item.driver}`}>
                <strong>{item.driver}</strong> — {item.contribution_pct}% ({item.direction})
              </li>
            ))}
          </ul>
        ) : <p className="confidence">No contribution rows were returned for this zone.</p>}
        {scenarios[0] && (
          <p className="confidence">
            <strong>Top cooling option:</strong> {scenarios[0].intervention} — {scenarios[0].flag && scenarios[0].flag !== 'none' ? scenarios[0].flag : `estimated ${Number(scenarios[0].est_reduction_c).toFixed(1)}°C reduction`}
          </p>
        )}
      </aside>
    )}
  </section>;
}
