import { useEffect, useRef } from 'react';
import L from 'leaflet';

// Madurai city centre
export const MADURAI_CENTER = [9.9252, 78.1198];
export const MADURAI_ZOOM = 12;

export default function MapView({ onReady }) {
  const ref = useRef(null);
  const mapRef = useRef(null);

  useEffect(() => {
    if (mapRef.current) return;
    const map = L.map(ref.current, { zoomControl: true }).setView(MADURAI_CENTER, MADURAI_ZOOM);

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    mapRef.current = map;
    if (onReady) onReady(map);

    // Keep the map sized correctly when the phone rotates or the layout changes
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(ref.current);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={ref} className="map" />;
}
