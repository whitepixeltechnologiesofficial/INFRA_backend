import { useState } from 'react';
import { Link } from 'react-router-dom';
import { DEMO_STATIONS, COMPLIANCE_RECORDS } from '../data_operations.js';

const roles={Planner:[['Heat Map','/'],['Cooling Simulator','/cooling-simulator'],['Recommendations','/recommendations']],Supervisor:[['Live Stations','/live-stations'],['Compliance Log','/compliance-log']],Inspector:[['Compliance Log','/compliance-log'],['Area Summary','/area-summary']],Health:[['Heat Map','/'],['Recommendations','/recommendations'],['Area Summary','/area-summary']]};
const cards=[
 {title:'Where is the danger?',value:'Zone 3 — East Madurai',detail:'44.1°C · Extreme',to:'/'},
 {title:'Why?',value:'Low tree cover',detail:'Largest heat driver in the hotspot',to:'/'},
 {title:'What should we do?',value:'Increase tree cover',detail:'Estimated cooling intervention',to:'/recommendations'},
 {title:'Are workers at risk now?',value:'3 / 5 online',detail:'1 open danger-level station alert',to:'/live-stations'},
 {title:'Did breaks happen?',value:'75% on time',detail:'Current compliance sample',to:'/compliance-log'}
];
export default function Overview(){const [role,setRole]=useState('Planner'); return <section className="overview-screen">
 <div className="overview-head"><div><span className="eyebrow">PRD 7.1 · CITY STATUS</span><h2>Overview</h2><p>One-glance status for Madurai heat, cooling and worker safety.</p></div><span className="demo-badge">DEMO MODE</span></div>
 <div className="role-tabs">{Object.keys(roles).map(r=><button key={r} className={role===r?'active':''} onClick={()=>setRole(r)}>{r}</button>)}</div>
 <div className="overview-grid">{cards.map(c=><Link className="overview-card" key={c.title} to={c.to}><small>{c.title}</small><strong>{c.value}</strong><span>{c.detail}</span><b>Open →</b></Link>)}</div>
 <div className="overview-bottom"><div><small>City average surface temperature</small><strong>40.2°C</strong><span>Latest Landsat scene</span></div><div><small>Stations</small><strong>{DEMO_STATIONS.filter(s=>s.status==='online').length} online / {DEMO_STATIONS.length}</strong><span>Highest current: Danger</span></div><div><small>Open alerts</small><strong>1</strong><span>Go to Live Stations</span></div></div>
 <div className="role-links"><strong>{role} quick links</strong>{roles[role].map(([label,to])=><Link key={to+label} to={to}>{label} →</Link>)}</div>
 </section>}
