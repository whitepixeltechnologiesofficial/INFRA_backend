import { useMemo, useState } from 'react';
import { useSatelliteData } from '../useSatelliteData.js';
import { sameZoneKey, zoneKeyFromZone } from '../portalContract.js';
import { DataEmpty, DataError, DataLoading, IssuesPanel } from '../components/DataState.jsx';
import { interventionKey, statusLabel, INTERVENTIONS } from '../data_cooling.js';

function csvEscape(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function downloadCsv(rows) {
  const header = ['Zone', 'Heat category', '#1 option', 'Estimated °C drop #1', '#2 option', 'Estimated °C drop #2', '#3 option', 'Estimated °C drop #3'];
  const lines = [header, ...rows.map((row) => [
    row.name,
    row.category,
    ...row.options.flatMap((option) => [
      option.intervention,
      option.flag && option.flag !== 'none' ? statusLabel(option) : Number(option.est_reduction_c).toFixed(1),
    ]),
  ])];
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(new Blob([lines.map((row) => row.map(csvEscape).join(',')).join('\n')], { type: 'text/csv' }));
  anchor.download = 'heat-shield-recommendations.csv';
  anchor.click();
}

export default function Recommendations() {
  const { data, error, loading, reload } = useSatelliteData();
  const [sort, setSort] = useState('hot');

  const rows = useMemo(() => (data?.zones || []).map((zone) => {
    const zoneKey = zoneKeyFromZone(zone);
    return {
      ...zone,
      zoneKey,
      options: (data?.scenarios || [])
        .filter((option) => sameZoneKey(option.zone_id, zoneKey))
        .sort((a, b) => Number(a.rank ?? 999) - Number(b.rank ?? 999))
        .slice(0, 3),
    };
  }).sort((a, b) => sort === 'drop'
    ? Number(b.options[0]?.est_reduction_c || 0) - Number(a.options[0]?.est_reduction_c || 0)
    : Number(b.mean_lst_c || 0) - Number(a.mean_lst_c || 0)), [data, sort]);

  return <section className="screen task3-screen recommendations-screen">
    <header className="task3-header rec-header">
      <div>
        <span className="eyebrow">PRD 7.5 · REAL SATELLITE RESULTS</span>
        <h2>Ranked cooling plan</h2>
        <p>Pre-calculated scenario results loaded from Supabase. Every cooling value is labelled estimated.</p>
      </div>
      <div className="rec-actions">
        <label>
          Sort by
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="hot">Hottest zone</option>
            <option value="drop">Biggest estimated drop</option>
          </select>
        </label>
        <button className="download-btn" onClick={() => downloadCsv(rows)} disabled={!rows.length}>Download CSV</button>
      </div>
    </header>

    {loading && <DataLoading label="Loading ranked recommendations…" />}
    {error && <DataError title="Satellite results unavailable" message={error} onRetry={reload} />}
    {!loading && !error && data && <IssuesPanel issues={data.issues} />}
    {!loading && !error && data && !rows.length && <DataEmpty message="No zones were returned by zones_portal." />}

    {!loading && !error && data && rows.length > 0 && (
      <div className="table-card">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Zone</th><th>Heat</th><th>#1 option</th><th>Estimated drop</th>
                <th>#2 option</th><th>Estimated drop</th><th>#3 option</th><th>Estimated drop</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.zoneKey || row.name}>
                  <td><strong>{row.name}</strong><small>{Number(row.mean_lst_c).toFixed(1)}°C surface temperature</small></td>
                  <td><span className="heat-chip">{row.category}</span></td>
                  {row.options.map((option) => (
                    <td key={`${row.zoneKey}-${option.intervention}`}>
                      <b className={option.flag && option.flag !== 'none' ? 'status-text' : 'drop'}>
                        {option.flag && option.flag !== 'none' ? statusLabel(option) : `${Number(option.est_reduction_c).toFixed(1)}°C`}
                      </b>
                      <small>{INTERVENTIONS[interventionKey(option.intervention)]?.label || option.intervention} · estimated</small>
                    </td>
                  ))}
                  {Array.from({ length: 3 - row.options.length }).map((_, index) => <td key={index}>—</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="table-note">All cooling numbers come from the live scenario_results_portal view and are labelled estimated.</div>
      </div>
    )}
  </section>;
}
