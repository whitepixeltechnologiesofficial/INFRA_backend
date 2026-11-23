import { useMemo } from 'react';
import { useSatelliteData } from '../useSatelliteData.js';
import { sameZoneKey, zoneKeyFromZone } from '../portalContract.js';
import { DataEmpty, DataError, DataLoading, IssuesPanel } from '../components/DataState.jsx';
import { interventionKey, statusLabel, INTERVENTIONS } from '../data_cooling.js';

export default function AreaSummary() {
  const { data, error, loading, reload } = useSatelliteData();
  const zones = useMemo(() => [...(data?.zones || [])].sort((a, b) => Number(b.mean_lst_c || 0) - Number(a.mean_lst_c || 0)), [data]);
  const sceneDate = data?.scene?.acquired_at ? new Date(data.scene.acquired_at).toLocaleDateString('en-IN') : null;

  return <section className="summary-screen print-area">
    <div className="summary-head no-print">
      <div>
        <span className="eyebrow">PRD 7.8 · REAL SATELLITE DATA</span>
        <h2>Area Summary</h2>
        <p>Printable summary generated from live zone, driver and scenario portal views.</p>
      </div>
      <button className="download-btn" onClick={() => window.print()} disabled={!data || !zones.length}>Print</button>
    </div>

    <div className="print-title">
      <h1>Satellite-to-Street Heat Shield</h1>
      <p>Area Summary · Madurai · {sceneDate || 'Satellite scene unavailable'}</p>
    </div>

    {loading && <DataLoading label="Loading live area summary…" />}
    {error && <DataError title="Satellite data unavailable" message={error} onRetry={reload} />}
    {!loading && !error && data && <IssuesPanel issues={data.issues} />}
    {!loading && !error && data && !zones.length && <DataEmpty message="No zones were returned by zones_portal." />}

    {!loading && !error && data && zones.length > 0 && (
      <div className="summary-list">
        {zones.map((zone, index) => {
          const zoneKey = zoneKeyFromZone(zone);
          const contributions = (data?.contributions || [])
            .filter((item) => sameZoneKey(item.zone_id, zoneKey))
            .sort((a, b) => Number(b.contribution_pct || 0) - Number(a.contribution_pct || 0));
          const best = (data?.scenarios || [])
            .filter((item) => sameZoneKey(item.zone_id, zoneKey))
            .sort((a, b) => Number(a.rank ?? 999) - Number(b.rank ?? 999))[0];
          return <article className="zone-summary" key={zoneKey || zone.name}>
            <div className="rank">#{index + 1}</div>
            <div>
              <h3>{zone.name}</h3>
              <div className="summary-tags"><b>{zone.category}</b><span>{Number(zone.mean_lst_c).toFixed(1)}°C</span></div>
              <p>
                <strong>Main driver:</strong> {contributions[0]?.driver || '—'} · <strong>Best cooling:</strong>{' '}
                {best ? `${INTERVENTIONS[interventionKey(best.intervention)]?.label || best.intervention} — ${statusLabel(best)}` : '—'}
              </p>
              <small>Scene: {sceneDate || '—'}</small>
            </div>
          </article>;
        })}
      </div>
    )}
  </section>;
}
