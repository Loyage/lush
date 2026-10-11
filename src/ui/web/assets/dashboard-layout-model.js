/** Read-only presentation seed; legacy account geometry remains in the device document. */
export function dashboardAccountLayout(layout, selectedIds, inherited = null) {
  const saved = Array.isArray(layout) ? layout : [];
  const result = saved.filter(cell => !cell.id.startsWith('account:')).map(cell => ({ ...cell }));
  if (result.some(cell => cell.id === 'accounts') || !selectedIds.length) return result;
  const selected = new Set(selectedIds.map(id => `account:${id.toLowerCase()}`));
  const first = saved.filter(cell => selected.has(cell.id.toLowerCase())).sort((a, b) => a.y - b.y || a.x - b.x)[0];
  const seed = inherited || (first ? { id: 'accounts', x: Math.min(first.x, 6), y: first.y, w: 6, h: 16 } : null);
  if (seed) result.push({ ...seed, id: 'accounts' });
  return result;
}
