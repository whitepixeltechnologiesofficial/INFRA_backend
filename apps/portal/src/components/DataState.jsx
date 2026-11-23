export function ConfigWarning({ message }) {
  return <div className="data-state data-state-warning" role="status">
    <strong>Supabase configuration problem</strong>
    <span>{message || 'Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY, then reload the portal.'}</span>
  </div>;
}

export function DataError({ title, message, onRetry }) {
  return <div className="data-state data-state-error" role="alert">
    <strong>{title}</strong>
    <span>{message}</span>
    {onRetry && <button type="button" onClick={onRetry}>Retry</button>}
  </div>;
}

export function DataLoading({ label }) {
  return <div className="data-state data-state-loading" role="status"><strong>{label || 'Loading live satellite data…'}</strong></div>;
}

export function DataEmpty({ message }) {
  return <div className="data-state data-state-empty" role="status"><strong>{message}</strong></div>;
}

export function IssuesPanel({ issues }) {
  if (!issues?.length) return null;
  return <div className="data-state-issues" role="status">
    {issues.map((issue, index) => <div key={`${issue.type}-${index}`} className={`data-state-issue data-state-${issue.level || 'warning'}`}>
      <strong>{issue.type}</strong>
      <span>{issue.message}</span>
    </div>)}
  </div>;
}
