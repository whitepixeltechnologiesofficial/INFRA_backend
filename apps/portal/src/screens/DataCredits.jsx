import { useSatelliteData } from '../useSatelliteData.js';
import { DataEmpty, DataError, DataLoading, IssuesPanel } from '../components/DataState.jsx';
import { DATA_CREDITS } from '../data_operations.js';
import { supabaseConfigured } from '../supabaseClient.js';

function sceneDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-IN');
}

function sceneTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
}

export default function DataCredits() {
  const { data, error, loading, reload } = useSatelliteData();
  const scene = data?.scene;
  const metrics = data?.metrics;

  return <section className="screen settings-screen">
    <div className="ops-header">
      <div>
        <span className="eyebrow">PRD 7.10 · DATA TRANSPARENCY</span>
        <h2>Data &amp; Credits</h2>
        <p>Sources, scene metadata and model information used by the portal.</p>
      </div>
    </div>

    {loading && <DataLoading label="Loading live scene metadata…" />}
    {error && <DataError title="Scene metadata unavailable" message={error} onRetry={reload} />}
    {!loading && !error && data && <IssuesPanel issues={data.issues} />}

    <div className="credits-layout">
      <div className="credits-card">
        <h3>Data sources &amp; attribution</h3>
        {DATA_CREDITS.map(([name, description]) => (
          <div className="credit-row" key={name}>
            <strong>{name}</strong>
            <span>{description}</span>
          </div>
        ))}
        <p className="estimate-disclaimer"><strong>All cooling numbers are model estimates.</strong></p>
      </div>

      <div className="credits-card">
        <h3>Satellite scene</h3>
        {!loading && !error && data && !scene && <DataEmpty message="No scene rows were returned by scenes_portal." />}
        <div className="metadata-grid">
          <div><small>Source</small><strong>{scene?.source || '—'}</strong></div>
          <div><small>Satellite</small><strong>{scene?.satellite || '—'}</strong></div>
          <div><small>Scene date</small><strong>{sceneDate(scene?.acquired_at)}</strong></div>
          <div><small>Scene time</small><strong>{sceneTime(scene?.acquired_at)}</strong></div>
          <div><small>Cloud cover</small><strong>{scene?.cloud_cover_pct != null ? `${scene.cloud_cover_pct}%` : '—'}</strong></div>
          <div><small>Model R²</small><strong>{metrics?.r2_score ?? '—'}</strong></div>
          <div><small>Average error</small><strong>{metrics?.mae_celsius != null ? `${metrics.mae_celsius}°C` : '—'}</strong></div>
          <div><small>Supabase</small><strong>{supabaseConfigured ? 'Connected' : 'Not configured'}</strong></div>
        </div>
        <p className="muted">Scene, model and attribution values are read from the portal views. No generated sample metadata is used when a live scene is unavailable.</p>
      </div>
    </div>
  </section>;
}
