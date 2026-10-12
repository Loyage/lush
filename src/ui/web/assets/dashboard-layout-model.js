import { WIDGET_SIZES } from './dashboard-widget-model.js';
import { AGGREGATE_SIZES } from './dashboard-widget-aggregate-model.js';

/** Grouped geometry is a read-only projection; independent member cells remain untouched. */
export function dashboardAggregateLayout(config, rows) {
  const saved = config?.layout || [], result = [];
  for (const row of rows) {
    const own = saved.find(cell => cell.id === row.id);
    if (own) { result.push({ ...own }); continue; }
    const members = new Set((config?.widgets || []).filter(widget => row.type === 'accounts' ? widget.type === 'accounts'
      : widget.project_id === row.id || widget.links.some(link => link.scope === 'project' && link.project_id === row.id)).map(widget => widget.id));
    const candidates = saved.filter(cell => members.has(cell.id) || (row.type === 'accounts' && row.connection_ids.some(id => cell.id === `account:${id}`)));
    const anchor = candidates.sort((a, b) => a.y - b.y || a.x - b.x)[0];
    if (anchor) {
      const size = AGGREGATE_SIZES[row.type];
      result.push({ id: row.id, x: Math.min(anchor.x, 12 - size.w), y: anchor.y, ...size });
    }
  }
  return result;
}

/** Read-only projection; only an explicit settings/layout write publishes these cells. */
export function dashboardWidgetLayout(layout, widgets) {
  const saved = Array.isArray(layout) ? layout : [];
  const result = saved.filter(cell => cell.id.startsWith('widget:')).map(cell => ({ ...cell }));
  for (const widget of widgets) {
    if (result.some(cell => cell.id === widget.id)) continue;
    const legacy = widget.project_id ? saved.find(cell => cell.id === widget.project_id)
      : widget.type === 'accounts' ? saved.find(cell => cell.id === 'accounts') || saved.filter(cell => widget.connection_ids.some(id => cell.id === `account:${id}`)).sort((a, b) => a.y - b.y || a.x - b.x)[0] : null;
    if (legacy) {
      const size = WIDGET_SIZES[widget.type];
      result.push({ id: widget.id, x: Math.min(legacy.x, 12 - size.w), y: legacy.y, ...size });
    }
  }
  return result;
}

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
