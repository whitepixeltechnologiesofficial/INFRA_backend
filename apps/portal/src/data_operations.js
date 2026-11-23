export const HEAT_LIMITS = {
  safe: '< 38°C heat index',
  caution: '38–40.9°C',
  danger: '41–53.9°C',
  extreme: '≥ 54°C',
};

export const DEMO_STATIONS = [
  { id:'STN-001', siteId:'SITE-01', site:'Madurai North Works', name:'North Gate', mode:'simulator', temp:39.2, humidity:58, heatIndex:43.1, status:'online', lastReading:'2 min ago', demo:true },
  { id:'STN-002', siteId:'SITE-01', site:'Madurai North Works', name:'Road Crew', mode:'simulator', temp:37.8, humidity:61, heatIndex:41.0, status:'online', lastReading:'1 min ago', demo:true },
  { id:'STN-003', siteId:'SITE-02', site:'Central Market Works', name:'Market East', mode:'simulator', temp:40.7, humidity:55, heatIndex:48.6, status:'online', lastReading:'30 sec ago', demo:true },
  { id:'STN-004', siteId:'SITE-02', site:'Central Market Works', name:'Market West', mode:'simulator', temp:36.9, humidity:64, heatIndex:39.0, status:'offline', lastReading:'18 min ago', demo:true },
  { id:'STN-005', siteId:'SITE-03', site:'River Works', name:'River Road', mode:'simulator', temp:35.8, humidity:67, heatIndex:38.1, status:'online', lastReading:'45 sec ago', demo:true },
];

export const COMPLIANCE_RECORDS = [
  { id:'BRK-2001', site:'Madurai North Works', station:'STN-001', due:'9:30 AM', confirmed:'9:29 AM', how:'Station button', check:'Verified', result:'Complied', date:'2026-10-07', demo:false },
  { id:'BRK-2002', site:'River Works', station:'STN-005', due:'10:30 AM', confirmed:'10:37 AM', how:'Portal PIN', check:'Confirmed - unverified', result:'Confirmed late', date:'2026-10-07', demo:false },
  { id:'BRK-1001', site:'Madurai North Works', station:'STN-001', due:'10:30 AM', confirmed:'10:29 AM', how:'Station button', check:'Verified', result:'Complied', date:'2026-10-07', demo:true },
  { id:'BRK-1002', site:'Madurai North Works', station:'STN-002', due:'11:00 AM', confirmed:'11:08 AM', how:'Portal PIN', check:'Confirmed - unverified', result:'Confirmed late', date:'2026-10-07', demo:true },
  { id:'BRK-1003', site:'Central Market Works', station:'STN-003', due:'12:00 PM', confirmed:'—', how:'—', check:'Flagged', result:'Not complied', date:'2026-10-07', demo:true },
  { id:'BRK-1004', site:'Central Market Works', station:'STN-004', due:'1:00 PM', confirmed:'—', how:'—', check:'Flagged', result:'Closed without confirmation', date:'2026-10-07', demo:true },
  { id:'BRK-1005', site:'River Works', station:'STN-005', due:'1:30 PM', confirmed:'1:30 PM', how:'Station button', check:'Verified', result:'Complied', date:'2026-10-07', demo:true },
  { id:'BRK-1006', site:'River Works', station:'STN-005', due:'2:30 PM', confirmed:'2:31 PM', how:'Station button', check:'Verified', result:'Complied', date:'2026-10-07', demo:true },
];

export const SCENE_INFO = {
  source: 'Landsat Collection 2 Level-2 (USGS)',
  satellite: 'Landsat 8/9',
  sceneDate: 'Selected scene at runtime',
  sceneTime: 'Scene acquisition time shown from source metadata',
  cloud: 'Shown from selected scene metadata',
  modelR2: 'Not loaded in R1 portal',
  modelMae: 'Not loaded in R1 portal',
};

export const DATA_CREDITS = [
  ['Landsat / USGS', 'Surface temperature — Landsat Collection 2 Level-2.'],
  ['ESA WorldCover', 'Land-cover data used by the heat analysis pipeline.'],
  ['© OpenStreetMap contributors', 'Base map and geographic context.'],
  ['Google Open Buildings', 'Building footprints/density used for driver analysis.'],
  ['Open-Meteo (CC BY 4.0)', 'Weather data when the weather card is enabled.'],
];
