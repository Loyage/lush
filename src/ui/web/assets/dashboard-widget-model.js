export const WIDGET_SECTIONS = {
  status: [['metrics', '状态指标'], ['distribution', '状态分布'], ['delivery', '合并进度']],
  messages: [['messages', '待答与告知']], workers: [['recent', 'Worker']],
  accounts: [['quota', '额度条'], ['balance', '余额'], ['reset', '重置时间'], ['observed', '观测年龄'], ['details', '指标详情'], ['history', '历史观测'], ['provenance', '来源信息']],
  shortcuts: [['shortcuts', '常用入口']],
};
export const WIDGET_NAMES = { status: '项目状态', messages: '消息', workers: 'Worker', accounts: '额度与余额', shortcuts: '常用入口' };
export const WIDGET_SIZES = { status: { w: 4, h: 10 }, messages: { w: 4, h: 10 }, workers: { w: 4, h: 10 }, accounts: { w: 6, h: 14 }, shortcuts: { w: 4, h: 8 } };
export const GLOBAL_LINKS = [['notices', '收件箱'], ['project-management', '项目管理'], ['model-sources', '模型和来源'], ['settings', '设置'], ['agent-status', 'Agent 状态'], ['automation', '自动化'], ['docs', '文档']];
export const PROJECT_LINKS = [['workers', '工作列表'], ['inputs', '历史输入'], ['notices', '待我处理']];
export const widgetId = value => typeof value === 'string' && /^widget:[a-z0-9][a-z0-9-]{0,79}$/.test(value);
const projectId = value => typeof value === 'string' && /^[a-f0-9]{16}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const unique = values => new Set(values).size === values.length;
export const isRetiredDashboardLink = link => link.scope === 'global' && link.target === 'runners';
/** Omit retired navigation only in an explicit widget write; never mutate the read document. */
export const writableDashboardWidgets = widgets => widgets?.map(widget => ({ ...structuredClone(widget),
  links: widget.links.filter(link => !isRetiredDashboardLink(link)).map(link => ({ ...link })) })) ?? widgets;
export function validWidget(row, { allowRetiredLinks = false } = {}) {
  if (!exact(row, ['id', 'type', 'project_id', 'connection_ids', 'links', 'sections']) || !widgetId(row.id) || !Object.hasOwn(WIDGET_SECTIONS, row.type)) return false;
  if (['status', 'messages', 'workers'].includes(row.type) ? !projectId(row.project_id) : row.project_id !== null) return false;
  if (!Array.isArray(row.connection_ids) || row.connection_ids.length > 100 || !unique(row.connection_ids.map(id => typeof id === 'string' ? id.toLowerCase() : id))
    || row.connection_ids.some(id => !uuid(id)) || (row.type !== 'accounts' && row.connection_ids.length)) return false;
  if (!Array.isArray(row.links) || row.links.length > 24 || (row.type !== 'shortcuts' && row.links.length)) return false;
  if (row.links.some(link => !exact(link, ['scope', 'target', 'project_id']) || (link.scope === 'global'
    ? link.project_id !== null || !(GLOBAL_LINKS.some(([target]) => target === link.target) || allowRetiredLinks && isRetiredDashboardLink(link))
    : link.scope !== 'project' || !projectId(link.project_id) || !(link.target === 'versions' || PROJECT_LINKS.some(([target]) => target === link.target))))) return false;
  // The v4 source permits repeated navigation links; do not reject its complete ACK.
  return Array.isArray(row.sections) && unique(row.sections)
    && row.sections.every(section => WIDGET_SECTIONS[row.type].some(([key]) => key === section));
}
export function validateWidgets(widgets, options = {}) {
  if (widgets === null) return null;
  if (!Array.isArray(widgets) || widgets.length > 100 || !unique(widgets.map(row => row?.id)) || widgets.some(row => !validWidget(row, options))) throw new Error('独立卡片配置无效');
  return structuredClone(widgets);
}
export function newWidget(type, id, project_id = null) {
  return { id, type, project_id, connection_ids: [], links: [], sections: WIDGET_SECTIONS[type].map(([key]) => key).filter(key => type !== 'accounts' || ['quota', 'balance', 'reset', 'observed'].includes(key)) };
}
/** Compatibility is a read-only projection, never a hidden settings migration. */
export function dashboardWidgets(config, projects) {
  if (config.widgets !== null && config.widgets !== undefined) return structuredClone(config.widgets);
  const result = [], links = [];
  for (const project of projects.filter(row => !config.hidden_projects.includes(row.id))) {
    const old = config.content.find(item => item.id === project.id)?.sections;
    for (const type of ['status', 'messages', 'workers']) {
      const widget = newWidget(type, `widget:${project.id}-${type}`, project.id);
      if (old) widget.sections = widget.sections.filter(section => old.includes(section));
      if (widget.sections.length) result.push(widget);
    }
    if (!old || old.includes('shortcuts')) links.push(...PROJECT_LINKS.slice(0, 3).map(([target]) => ({ scope: 'project', target, project_id: project.id })));
  }
  if (config.cards.length) {
    const widget = newWidget('accounts', 'widget:accounts'); widget.connection_ids = config.cards.map(card => card.connection_id);
    widget.sections = config.content.find(item => item.id === 'accounts')?.sections || widget.sections; result.push(widget);
  }
  const widget = newWidget('shortcuts', 'widget:shortcuts');
  widget.links = [...GLOBAL_LINKS.slice(0, 3).map(([target]) => ({ scope: 'global', target, project_id: null })), ...links].slice(0, 24);
  result.push(widget); return result;
}
export function placedAccountIds(widgets) { return [...new Set(widgets.filter(row => row.type === 'accounts').flatMap(row => row.connection_ids))]; }
export function widgetRows(widgets, projects, connections) {
  return widgets.map(saved => {
    // Hide retired shortcuts in the read projection; do not migrate persisted settings.
    const widget = { ...saved, links: saved.links.filter(link => !isRetiredDashboardLink(link) && !(link.scope === 'project' && link.target === 'versions')) };
    const source = projects.find(row => row.id === widget.project_id) || (widget.project_id ? { id: widget.project_id, name: '来源项目不可用', running: false, error: '来源项目已移除或不可用' } : null);
    return { ...widget, widget_type: widget.type, source, linkLabels: widget.links.map(link => link.scope === 'project' ? projects.find(row => row.id === link.project_id)?.name || '来源项目不可用' : null), name: source ? `${source.name || '未命名项目'} · ${WIDGET_NAMES[widget.type]}` : WIDGET_NAMES[widget.type],
      accounts: widget.connection_ids.map(connection_id => ({ id: `account:${connection_id}`, type: 'account', connection_id, connection: connections.find(row => row.id === connection_id) || null })) };
  });
}
/** Preserve the visible source anchor across positive and zero-capacity projections. */
export function reflowWidgetPage(state, capacity) {
  const previous = state.capacity || state.lastCapacity;
  if (capacity > 0 && previous > 0 && previous !== capacity) state.index = Math.floor(state.index * previous / capacity);
  if (capacity > 0) state.lastCapacity = capacity;
  state.capacity = capacity;
}

/** The same ordinary-control token sizes CSS rows and renderer pagination. */
export function dashboardSizing() {
  const style = globalThis.document?.documentElement && globalThis.getComputedStyle?.(document.documentElement);
  const control = parseFloat(style?.getPropertyValue?.('--control-height')) || 32;
  const primary = parseFloat(style?.getPropertyValue?.('--control-primary-height')) || control;
  return { control, primary, shell: 52 + control * 2, account: control + 44, gap: 4 };
}

/** Fixed slot capacity depends on geometry, not business count or label length. */
export function widgetSlots(type, geometry = WIDGET_SIZES[type]) {
  const h = Number.isFinite(geometry?.h) ? geometry.h : WIDGET_SIZES[type].h;
  // Margin12 + border6 + padding22 + gaps12; header/footer follow the token.
  const size = dashboardSizing(), body = Math.max(0, h * 24 - size.shell);
  const rowHeight = type === 'accounts' ? size.account : size.control;
  return Math.max(0, Math.min(12, Math.floor((body + size.gap) / (rowHeight + size.gap))));
}
