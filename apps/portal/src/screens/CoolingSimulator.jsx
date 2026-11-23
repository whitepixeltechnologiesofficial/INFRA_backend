import { useEffect, useMemo, useState } from 'react';
import L from 'leaflet';
import { useSatelliteData } from '../useSatelliteData.js';
import { zoneFeatureCollection } from '../satelliteData.js';
import { sameZoneKey, zoneKeyFromFeature, zoneKeyFromZone } from '../portalContract.js';
import { DataEmpty, DataError, DataLoading, IssuesPanel } from '../components/DataState.jsx';
import { INTERVENTIONS, interventionKey, statusLabel } from '../data_cooling.js';

function SimulatorMap({ data, intervention, selectedId, onSelect }) {
  const [node, setNode] = useState(null);

  useEffect(() => {
    if (!node || !data) return undefined;
    const map = L.map(node, { zoomControl: true }).setView([9.9252, 78.1198], 11);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    const fc = zoneFeatureCollection(data);
    const layer = L.geoJSON(fc, {
      style: (feature) => {
        const zoneKey = zoneKeyFromFeature(feature);
        const zone = data.zones.find((item) => sameZoneKey(item, zoneKey));
        const option = (data.scenarios || []).find((item) => sameZoneKey(item.zone_id, zoneKey) && interventionKey(item.intervention) === intervention);
        const value = Number(option?.est_reduction_c || 0);
        const selected = sameZoneKey(zone, selectedId);
        return {
          color: selected ? '#111827' : '#c2410c',
          weight: selected ? 3 : 1.5,
          fillColor: value >= 2.8 ? '#991b1b' : value >= 2 ? '#dc2626' : value > 0 ? '#facc15' : '#cbd5e1',
          fillOpacity: 0.55,
        };
      },
      onEachFeature: (feature, leafletLayer) => leafletLayer.on('click', () => onSelect(zoneKeyFromFeature(feature))),
    }).addTo(map);

    if (layer.getBounds().isValid()) map.fitBounds(layer.getBounds(), { padding: [20, 20] });
    return () => map.remove();
  }, [node, data, intervention, selectedId, onSelect]);

  return <div ref={setNode} className="map task3-map" />;
}

export default function CoolingSimulator() {
  const { data, error, loading, reload } = useSatelliteData();
  const [intervention, setIntervention] = useState('trees');
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    if (data && selectedId === null) setSelectedId(zoneKeyFromZone(data.zones?.[0]));
  }, [data, selectedId]);

  const rows = useMemo(() => (data?.zones || []).map((zone) => {
    const zoneKey = zoneKeyFromZone(zone);
    const option = (data?.scenarios || []).find((item) => sameZoneKey(item.zone_id, zoneKey) && interventionKey(item.intervention) === intervention);
    return { ...zone, zoneKey, option };
  }).sort((a, b) => Number(b.option?.est_reduction_c || 0) - Number(a.option?.est_reduction_c || 0)), [data, intervention]);

  const selected = rows.find((zone) => sameZoneKey(zone, selectedId)) || rows[0];
  const optionCount = (data?.scenarios || []).filter((item) => interventionKey(item.intervention) === intervention).length;

  return <section className="screen task3-screen">
    <header className="task3-header">
      <div>
        <span className="eyebrow">PRD 7.4 · REAL SCENARIO RESULTS</span>
        <h2>Cooling Simulator</h2>
        <p>Pre-calculated satellite/AI scenarios from Supabase. Values are estimates, not live model recalculation.</p>
      </div>
      <div className="task3-select" role="group">
        {Object.entries(INTERVENTIONS).map(([key, item]) => (
          <button key={key} className={intervention === key ? 'selected' : ''} onClick={() => setIntervention(key)}>{item.label}</button>
        ))}
      </div>
    </header>

    {loading && <DataLoading label="Loading live scenario results…" />}
    {error && <DataError title="Scenario data unavailable" message={error} onRetry={reload} />}
    {!loading && !error && data && <IssuesPanel issues={data.issues} />}
    {!loading && !error && data && !data.zones?.length && <DataEmpty message="No zones were returned by zones_portal." />}
    {!loading && !error && data && data.zones?.length > 0 && !optionCount && <DataEmpty message={`No ${INTERVENTIONS[intervention].label} rows were returned by scenario_results_portal.`} />}

    {!loading && !error && data && data.zones?.length > 0 && optionCount > 0 && (
      <div className="task3-layout">
        <div className="task3-map-card">
          <div className="task3-map-caption">
            <strong>{INTERVENTIONS[intervention].label}</strong>
            <span>Live scenario_results_portal · estimated</span>
          </div>
          <SimulatorMap data={data} intervention={intervention} selectedId={selected?.zoneKey} onSelect={setSelectedId} />
        </div>
        <aside className="task3-side">
          {selected && (
            <div className="task3-selected">
              <span className="eyebrow">SELECTED ZONE</span>
              <h3>{selected.name}</h3>
              <div className="selected-temp"><span>{selected.category}</span><strong>{Number(selected.mean_lst_c).toFixed(1)}°C</strong></div>
              <p>{INTERVENTIONS[intervention].description}</p>
              <div className="estimate-box"><small>Estimated cooling</small><strong>{statusLabel(selected.option)}</strong></div>
            </div>
          )}
          <div className="ranked">
            <div className="ranked-title"><strong>Ranked zones</strong><span>by estimated drop</span></div>
            {rows.map((zone, index) => (
              <button className={`rank-row ${sameZoneKey(zone, selected?.zoneKey) ? 'active' : ''}`} key={zone.zoneKey || zone.name} onClick={() => setSelectedId(zone.zoneKey)}>
                <span className="rank-num">{index + 1}</span>
                <span className="rank-name"><b>{zone.name}</b><small>{zone.category}</small></span>
                <strong>{zone.option?.flag && zone.option.flag !== 'none' ? '—' : `${Number(zone.option?.est_reduction_c || 0).toFixed(1)}°C`}</strong>
              </button>
            ))}
          </div>
          <p className="task3-footnote">Values are model estimates and are applied only where suitable.</p>
        </aside>
      </div>
    )}
  </section>;
}
