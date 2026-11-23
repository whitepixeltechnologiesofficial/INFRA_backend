import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabaseClient.js';
import { DEMO_STATIONS, HEAT_LIMITS } from '../data_operations.js';

function classify(hi) {
  if (hi >= 54) return 'Extreme Danger';
  if (hi >= 41) return 'Danger';
  if (hi >= 38) return 'Caution';
  return 'Safe';
}
function heatIndex(temp, humidity) {
  return temp + Math.max(0, (humidity - 40) * 0.16) + (temp > 30 ? (temp - 30) * 0.18 : 0);
}
function statusClass(category) { return category.toLowerCase().replace(/\s+/g,'-'); }

function MiniChart({ station }) {
  const points = useMemo(() => Array.from({length:12}, (_,i) => {
    const wave = Math.sin(i * 0.9) * 1.8 + Math.cos(i * 0.45) * .8;
    return Math.max(35, station.heatIndex + wave - (11-i)*.08);
  }), [station.heatIndex]);
  const min = Math.min(...points, 35), max = Math.max(...points, 54);
  const path = points.map((v,i) => `${(i/11)*100},${92-((v-min)/(max-min))*78}`).join(' ');
  return <div className="station-chart"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Last two hours heat index chart"><line x1="0" x2="100" y1={92-((41-min)/(max-min))*78} y2={92-((41-min)/(max-min))*78} stroke="#ef4444" strokeDasharray="3 3"/><line x1="0" x2="100" y1={92-((54-min)/(max-min))*78} y2={92-((54-min)/(max-min))*78} stroke="#991b1b" strokeDasharray="3 3"/><polyline fill="none" stroke="#c2410c" strokeWidth="2.5" points={path}/></svg><div className="chart-labels"><span>2h ago</span><span>Danger 41</span><span>Extreme 54</span><span>Now</span></div></div>;
}

export default function LiveStations() {
  const [stations, setStations] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [activeAlerts, setActiveAlerts] = useState({});
  const [site, setSite] = useState('ALL');
  const [selected, setSelected] = useState(DEMO_STATIONS[0]);
  const [simTemp, setSimTemp] = useState(39.2);
  const [breakModal, setBreakModal] = useState(false);
  const [pin, setPin] = useState('');
  const [breakMessage, setBreakMessage] = useState('');
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [alertSeen, setAlertSeen] = useState(false);

  useEffect(() => {
    if (!supabase) { setStations(DEMO_STATIONS); setLoaded(true); return; }
    let active = true;
    (async () => {
      const [{ data: stationRows, error: stationError }, { data: alertRows }] = await Promise.all([
        supabase.from('stations').select('*').limit(100),
        supabase.from('alerts').select('*').is('closed_at', null).limit(100),
      ]);
      if (!active) return;
      if (stationError || !stationRows?.length) { setStations(DEMO_STATIONS); }
      else {
        setStations(stationRows.map((s) => ({ id:s.id || s.station_id, siteId:s.site_id, site:s.site_name || s.site_id || 'Site', name:s.name || s.station_id || s.id, mode:s.mode || 'real', temp:Number(s.temp_c ?? s.temperature_c ?? 0), humidity:Number(s.humidity_pct ?? 0), heatIndex:Number(s.heat_index_c ?? 0), status:s.status || 'offline', lastReading:s.last_reading_at ? new Date(s.last_reading_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}) : '—', demo:Boolean(s.is_demo) })));
      }
      setActiveAlerts(Object.fromEntries((alertRows || []).map((a) => [a.station_id, a])));
      setLoaded(true);
    })();
    const channel = supabase.channel('live-station-readings')
      .on('postgres_changes', {event:'INSERT', schema:'public', table:'readings'}, payload => {
        const r = payload.new;
        setStations(prev => prev.map(s => s.id === r.station_id ? {...s, temp:Number(r.temp_c), humidity:Number(r.humidity_pct), heatIndex:Number(r.heat_index_c), status:'online', lastReading:'just now'} : s));
      })
      .on('postgres_changes', {event:'*', schema:'public', table:'alerts'}, payload => {
        const a = payload.new;
        setActiveAlerts(prev => { const next = {...prev}; if (payload.eventType === 'DELETE' || a.closed_at) delete next[a.station_id]; else next[a.station_id] = a; return next; });
      }).subscribe();
    return () => { active=false; supabase.removeChannel(channel); };
  }, []);

  useEffect(() => {
    if (!selected) return;
    const current = stations.find(s => s.id === selected.id);
    if (current) setSelected(current);
  }, [stations, selected?.id]);

  const filtered = site === 'ALL' ? stations : stations.filter(s => s.siteId === site);
  const sites = [...new Map(stations.map(s => [s.siteId, s.site])).entries()];
  const selectedCategory = classify(selected?.heatIndex || 0);
  useEffect(() => {
    const danger = selectedCategory === 'Danger' || selectedCategory === 'Extreme Danger';
    if (danger && !alertSeen && soundEnabled) {
      try { const Ctx = window.AudioContext || window.webkitAudioContext; const ctx = new Ctx(); const osc = ctx.createOscillator(); const gain = ctx.createGain(); osc.frequency.value = selectedCategory === 'Extreme Danger' ? 880 : 660; gain.gain.value = 0.045; osc.connect(gain); gain.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.28); } catch {}
      setAlertSeen(true);
    }
    if (!danger) setAlertSeen(false);
  }, [selectedCategory, soundEnabled, alertSeen]);
  const siteWorst = filtered.length ? filtered.reduce((worst,s) => (s.status === 'offline' ? s : s.heatIndex > worst.heatIndex ? s : worst), filtered[0]) : null;
  const applySlider = (value) => {
    const temp = Number(value); setSimTemp(temp);
    const updated = {...stations.find(s => s.id === 'STN-001'), temp, heatIndex:heatIndex(temp,58), status:'online', lastReading:'just now'};
    setStations(prev => prev.map(s => s.id === 'STN-001' ? updated : s));
    setSelected(updated);
  };
  const activeAlert = selected ? activeAlerts[selected.id] : null;
  const currentStep = selected?.status === 'offline' ? 'Paused - station offline' : activeAlert?.state === 'break_in_progress' ? 'Break in progress' : selectedCategory === 'Extreme Danger' ? 'Stop outdoor work' : selectedCategory === 'Danger' ? 'Break due now' : selectedCategory === 'Caution' ? 'Work allowed' : 'Work allowed - conditions safe';
  const confirmBreak = async () => {
    if (!supabase || !activeAlert?.id) {
      if (pin !== (import.meta.env.VITE_DEMO_SITE_PIN || '1234')) return setBreakMessage('Invalid site PIN.');
      setBreakMessage('Break confirmed for the demo station.'); setBreakModal(false); setPin(''); return;
    }
    const expectedPin = import.meta.env.VITE_DEMO_SITE_PIN || '1234';
    if (pin !== expectedPin) return setBreakMessage('Invalid site PIN.');
    const now = new Date().toISOString();
    const { error } = await supabase.from('alerts').update({ state:'break_in_progress', confirmed_at:now }).eq('id', activeAlert.id);
    if (error) return setBreakMessage(`Break could not be recorded: ${error.message}`);
    setBreakMessage('Break confirmed. Status: Break in progress.'); setBreakModal(false); setPin('');
  };

  return <section className="screen operations-screen">
    <div className="ops-header"><div><span className="eyebrow">PRD 7.6 · GROUND SAFETY</span><h2>Live Stations</h2><p>Real-time worksite heat, alerts and break state.</p></div><div className="ops-header-actions"><button className={`sound-btn ${soundEnabled?'on':''}`} onClick={()=>setSoundEnabled(true)}>{soundEnabled?'🔊 Alert sound enabled':'🔔 Enable alert sound'}</button><select value={site} onChange={e=>setSite(e.target.value)}><option value="ALL">All sites</option>{sites.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></div></div>
    {(selectedCategory === 'Danger' || selectedCategory === 'Extreme Danger') && <div className={`live-alert ${selectedCategory === 'Extreme Danger' ? 'extreme' : ''}`}><strong>{selectedCategory === 'Extreme Danger' ? 'STOP OUTDOOR WORK' : 'BREAK DUE NOW'}</strong><span>{selected.name} has reached {selected.heatIndex.toFixed(1)}°C heat index.</span></div>}
    <div className="demo-strip"><strong>DEMO</strong><span>{loaded ? 'Live station readings and alerts are connected to Supabase Realtime.' : 'Loading live station data…'}</span></div>
    <div className="station-layout">
      <div className="station-list">
        <div className="site-status"><span>Site status</span><strong className={siteWorst?.status === 'offline' ? 'offline-text' : statusClass(classify(siteWorst?.heatIndex || 0))}>{siteWorst?.status === 'offline' ? 'Offline' : classify(siteWorst?.heatIndex || 0)}</strong></div>
        {filtered.map(s => { const cat=classify(s.heatIndex); return <button key={s.id} className={`station-card ${selected?.id===s.id?'selected':''}`} onClick={()=>setSelected(s)}><div className={`station-dot ${s.status}`}/><div className="station-card-main"><strong>{s.name}</strong><small>{s.site} · {s.id}</small><div className="station-values"><b>{s.heatIndex.toFixed(1)}°C</b><span>{cat}</span><span>{s.temp.toFixed(1)}°C · {s.humidity}% RH</span></div></div><span className={`online-badge ${s.status}`}>{s.status==='online'?'Online':'Offline'}</span></button> })}
      </div>
      {selected && <aside className="station-detail"><div className="detail-title"><div><span className="eyebrow">STATION DETAIL</span><h3>{selected.name}</h3><p>{selected.site} · {selected.id}</p></div><span className="demo-badge">DEMO</span></div><div className={`big-status ${statusClass(selectedCategory)}`}><span>{selectedCategory}</span><strong>{selected.heatIndex.toFixed(1)}°C</strong></div><div className="current-grid"><div><small>Temperature</small><strong>{selected.temp.toFixed(1)}°C</strong></div><div><small>Humidity</small><strong>{selected.humidity}%</strong></div><div><small>Last reading</small><strong>{selected.lastReading}</strong></div><div><small>Mode</small><strong>{selected.mode}</strong></div></div><div className="step-banner"><small>Current step</small><strong>{currentStep}</strong></div>{selected.id==='STN-001' && <div className="simulator-box"><div><strong>Wokwi-style demo control</strong><small>Move the temperature slider to test alert states.</small></div><input type="range" min="32" max="56" step="0.1" value={simTemp} onChange={e=>applySlider(e.target.value)}/><div className="slider-value">{simTemp.toFixed(1)}°C air temperature → {selected.heatIndex.toFixed(1)}°C heat index</div></div>}<MiniChart station={selected}/>{breakMessage && <div className="break-message">{breakMessage}</div>}{selected.status==='online' && (selectedCategory==='Danger' || selectedCategory==='Extreme Danger') && <button className="break-btn" onClick={()=>setBreakModal(true)}>Break given</button>}<p className="ops-note">Limits: {HEAT_LIMITS.safe}; caution {HEAT_LIMITS.caution}; danger {HEAT_LIMITS.danger}; extreme {HEAT_LIMITS.extreme}.</p></aside>}
    </div>
    {breakModal && <div className="modal-backdrop"><div className="pin-modal"><h3>Confirm break</h3><p>Enter the site PIN to record this break.</p><input autoFocus type="password" value={pin} onChange={e=>setPin(e.target.value)} placeholder="Site PIN"/><div className="modal-actions"><button onClick={()=>setBreakModal(false)}>Cancel</button><button className="download-btn" onClick={confirmBreak}>Confirm</button></div></div></div>}
  </section>;
}
