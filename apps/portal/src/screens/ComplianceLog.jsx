import { useMemo, useState } from 'react';
import { useEffect } from 'react';
import { supabase } from '../supabaseClient.js';
import { COMPLIANCE_RECORDS } from '../data_operations.js';

function csvCell(v){ return `"${String(v ?? '').replace(/"/g,'""')}"`; }
export default function ComplianceLog(){
  const [records,setRecords] = useState(COMPLIANCE_RECORDS);
  useEffect(() => {
    if (!supabase) return;
    let active = true;
    (async () => {
      const { data, error } = await supabase.from('breaks').select('*').order('due_at',{ascending:false}).limit(200);
      if (!active || error || !data?.length) return;
      const mapped = data.map((r,i) => ({ id:r.id || `live-${i}`, site:r.site_name || r.site || 'Site', station:r.station_id || '—', due:r.due_at ? new Date(r.due_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}) : '—', confirmed:r.confirmed_at ? new Date(r.confirmed_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}) : '—', how:r.confirmed_by || '—', check:r.check || (r.verified ? 'Verified' : 'Confirmed - unverified'), result:r.result || r.status || 'Complied', date:r.due_at ? new Date(r.due_at).toISOString().slice(0,10) : '', demo:Boolean(r.is_demo) }));
      setRecords(mapped);
    })();
    return () => { active=false; };
  }, []);
  const [site,setSite]=useState('ALL'); const [result,setResult]=useState('ALL'); const [check,setCheck]=useState('ALL'); const [showDemo,setShowDemo]=useState(false);
  const filtered=useMemo(()=>records.filter(r=>(showDemo||!r.demo)&&(site==='ALL'||r.site===site)&&(result==='ALL'||r.result===result)&&(check==='ALL'||r.check===check)),[records,site,result,check,showDemo]);
  const required=filtered.length; const onTime=filtered.filter(r=>r.result==='Complied').length; const verified=filtered.filter(r=>r.check==='Verified').length; const flagged=filtered.filter(r=>r.check==='Flagged').length;
  const download=()=>{ const header=['Site','Station','Break due time','Confirmed time','How confirmed','Break check','Result','Date']; const rows=filtered.map(r=>[r.site,r.station,r.due,r.confirmed,r.how,r.check,r.result,r.date]); const blob=new Blob([[header,...rows].map(row=>row.map(csvCell).join(',')).join('\n')],{type:'text/csv;charset=utf-8'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='compliance-log.csv'; a.click(); URL.revokeObjectURL(a.href); };
  const sites=[...new Set(records.map(r=>r.site))];
  return <section className="screen operations-screen compliance-screen"><div className="ops-header"><div><span className="eyebrow">PRD 7.7 · VERIFIABLE RECORD</span><h2>Compliance Log</h2><p>Break checks, confirmations and inspection-ready results.</p></div><button className="download-btn" onClick={download}>Download CSV</button></div><div className="filter-bar"><label>Site<select value={site} onChange={e=>setSite(e.target.value)}><option value="ALL">All sites</option>{sites.map(s=><option key={s}>{s}</option>)}</select></label><label>Result<select value={result} onChange={e=>setResult(e.target.value)}><option value="ALL">All results</option><option>Complied</option><option>Confirmed late</option><option>Not complied</option><option>Closed without confirmation</option></select></label><label>Check<select value={check} onChange={e=>setCheck(e.target.value)}><option value="ALL">All checks</option><option>Verified</option><option>Confirmed - unverified</option><option>Flagged</option></select></label><label className="demo-toggle"><input type="checkbox" checked={showDemo} onChange={e=>setShowDemo(e.target.checked)}/> Show demo records</label></div><div className="summary-cards"><div><small>Breaks on time %</small><strong>{required?Math.round(onTime/required*100):0}%</strong><span>{onTime} / {required} required breaks</span></div><div><small>Verified %</small><strong>{required?Math.round(verified/required*100):0}%</strong><span>{verified} verified</span></div><div><small>Flagged breaks</small><strong>{flagged}</strong><span>Needs inspection</span></div><div><small>Offline closures</small><strong>{filtered.filter(r=>r.result==='Closed without confirmation').length}</strong><span>Closed while station offline</span></div></div><div className="table-card compliance-table"><div className="table-scroll"><table><thead><tr><th>Site</th><th>Station</th><th>Break due</th><th>Confirmed</th><th>How confirmed</th><th>Break check</th><th>Result</th></tr></thead><tbody>{filtered.length?filtered.map(r=><tr key={r.id}><td><strong>{r.site}</strong><small>{r.date}</small></td><td>{r.station}</td><td>{r.due}</td><td>{r.confirmed}</td><td>{r.how}</td><td><span className={`check-pill ${r.check.toLowerCase().replace(/[^a-z]+/g,'-')}`}>{r.check}</span></td><td><strong>{r.result}</strong></td></tr>):<tr><td colSpan="7" className="empty-row">No alerts in this period</td></tr>}</tbody></table></div><div className="table-note">No delete action is provided. Compliance records are intended to remain auditable.</div></div></section>;
}
