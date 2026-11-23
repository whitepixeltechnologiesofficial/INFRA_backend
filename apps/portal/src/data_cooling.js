export const INTERVENTIONS = {
  trees: { label: 'Trees', short: 'Tree cover', description: 'Pre-calculated satellite/AI estimate for suitable areas.' },
  roofs: { label: 'Cool roofs', short: 'Cool roofs', description: 'Pre-calculated satellite/AI estimate for suitable built-up areas.' },
  water: { label: 'Water bodies', short: 'Water bodies', description: 'Pre-calculated satellite/AI estimate for suitable areas.' },
};

export function interventionKey(value) {
  const v = String(value || '').toLowerCase();
  if (v.includes('tree') || v.includes('veget')) return 'trees';
  if (v.includes('roof') || v.includes('albedo')) return 'roofs';
  if (v.includes('water')) return 'water';
  return v;
}

export function statusLabel(option) {
  if (!option) return 'No result';
  const flag = String(option.flag || '').toLowerCase();
  if (flag === 'not_suitable') return 'Not suitable';
  if (flag === 'low_benefit') return 'Little or no benefit';
  if (flag === 'out_of_range') return 'Outside typical range';
  if (flag && flag !== 'none') return flag.replaceAll('_', ' ');
  return `Estimated ${Number(option.est_reduction_c || 0).toFixed(1)}°C drop`;
}
