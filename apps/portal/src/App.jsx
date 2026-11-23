import { useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { SCREENS } from './screens.js';
import HeatMap from './screens/HeatMap.jsx';
import EmptyScreen from './screens/EmptyScreen.jsx';
import DataCredits from './screens/DataCredits.jsx';
import CoolingSimulator from './screens/CoolingSimulator.jsx';
import Recommendations from './screens/Recommendations.jsx';
import LiveStations from './screens/LiveStations.jsx';
import ComplianceLog from './screens/ComplianceLog.jsx';
import Settings from './screens/Settings.jsx';
import Overview from './screens/Overview.jsx';
import AreaSummary from './screens/AreaSummary.jsx';
import TrustLoop from './screens/TrustLoop.jsx';
import { supabaseConfigured, supabaseError } from './supabaseClient.js';
import { ConfigWarning } from './components/DataState.jsx';

export default function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  useLocation(); // re-render on navigation

  return (
    <div className="app">
      <header className="header">
        <button
          className="menu-btn"
          aria-label="Toggle menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          ☰
        </button>
        <h1 className="title">Satellite-to-Street Heat Shield</h1>
      </header>

      <div className="body">
        <nav className={`menu ${menuOpen ? 'open' : ''}`} aria-label="Screens">
          {SCREENS.map((s) => (
            <NavLink
              key={s.path}
              to={s.path}
              end={s.path === '/'}
              className={({ isActive }) => `menu-link ${isActive ? 'active' : ''}`}
              onClick={() => setMenuOpen(false)}
            >
              {s.label}
            </NavLink>
          ))}
        </nav>

        <main className="content">
          {(!supabaseConfigured || supabaseError) && <ConfigWarning message={supabaseError} />}
          <Routes>
            <Route path="/" element={<HeatMap />} />
            <Route path="/overview" element={<Overview />} />
            <Route path="/data-credits" element={<DataCredits />} />
            <Route path="/cooling-simulator" element={<CoolingSimulator />} />
            <Route path="/recommendations" element={<Recommendations />} />
            <Route path="/live-stations" element={<LiveStations />} />
            <Route path="/compliance-log" element={<ComplianceLog />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/area-summary" element={<AreaSummary />} />
            <Route path="/trust-loop" element={<TrustLoop />} />
            {SCREENS.filter((s) => !['/', '/data-credits', '/cooling-simulator', '/recommendations', '/live-stations', '/compliance-log', '/settings'].includes(s.path)).map((s) => (
              <Route key={s.path} path={s.path} element={<EmptyScreen title={s.label} note={s.note} />} />
            ))}
            <Route path="*" element={<EmptyScreen title="Not found" note="This screen does not exist." />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
