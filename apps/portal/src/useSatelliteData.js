import { useCallback, useEffect, useState } from 'react';
import { loadSatelliteData } from './satelliteData.js';

export function useSatelliteData() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await loadSatelliteData();
      setData(result);
      return result;
    } catch (loadError) {
      setData(null);
      setError(loadError?.message || 'Live satellite data could not be loaded.');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, loading, reload };
}
