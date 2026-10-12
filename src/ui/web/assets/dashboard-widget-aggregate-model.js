import { newWidget, validateWidgets, GLOBAL_LINKS, PROJECT_LINKS, WIDGET_SECTIONS } from './dashboard-widget-model.js';
import { PROJECT_CARD_DEFAULTS } from './project-dashboard-content.js';

export const ACCOUNT_DEFAULTS = ['quota', 'balance', 'reset', 'observed'];
export const AGGREGATE_SIZES = { project: { w: 6, h: 24 }, accounts: { w: 6, h: 16 } };
const explicit = config => Array.isArray(config.widgets);
const unique = values => [...new Set(values)];
const sameLink = (a, b) => a.scope === b.scope && a.target === b.target && a.project_id === b.project_id;
const legacySections = (config, id, defaults) => config.content.find(item => item.id === id)?.sections ?? defaults;
const projectTypes = ['status', 'messages', 'workers'];
const projectLinks = id => PROJECT_LINKS.slice(0, 3).map(([target]) => ({ scope: 'project', target, project_id: id }));
const globalLinks = () => GLOBAL_LINKS.slice(0, 3).map(([target]) => ({ scope: 'global', target, project_id: null }));

export function aggregateProjectIds(config, projects) {
  return explicit(config) ? unique(config.widgets.flatMap(widget => widget.project_id ? [widget.project_id]
    : widget.links.filter(link => link.scope === 'project').map(link => link.project_id)))
    : projects.filter(row => !config.hidden_projects.includes(row.id)).map(row => row.id);
}
export function aggregateAccountIds(config) {
  return explicit(config) ? unique(config.widgets.filter(widget => widget.type === 'accounts').flatMap(widget => widget.connection_ids))
    : config.cards.map(card => card.connection_id);
}
export function aggregateLinks(config, id = null, { selectedOnly = true } = {}) {
  if (!explicit(config)) return id ? (selectedOnly && !legacySections(config, id, PROJECT_CARD_DEFAULTS).includes('shortcuts') ? [] : projectLinks(id)) : globalLinks();
  return config.widgets.filter(widget => widget.type === 'shortcuts' && (!selectedOnly || widget.sections.includes('shortcuts')))
    .flatMap(widget => widget.links.filter(link => id ? link.scope === 'project' && link.project_id === id : link.scope === 'global'));
}
export function aggregateSections(config, id) {
  if (!explicit(config)) return [...legacySections(config, id, id === 'accounts' ? ACCOUNT_DEFAULTS : PROJECT_CARD_DEFAULTS)];
  if (id === 'accounts') return unique(config.widgets.filter(widget => widget.type === 'accounts').flatMap(widget => widget.sections));
  return unique([...config.widgets.filter(widget => widget.project_id === id).flatMap(widget => widget.sections),
    ...(aggregateLinks(config, id).length ? ['shortcuts'] : [])]);
}
/** v4 membership is authoritative. Empty sections and missing sources still have a window. */
export function aggregateRows(config, projects, connections) {
  const rows = aggregateProjectIds(config, projects).map(id => {
    const source = projects.find(row => row.id === id) || { id, name: '来源项目不可用', running: false, error: '来源项目已移除或不可用' };
    return { ...source, type: 'project', project_id: id, source, sections: aggregateSections(config, id), links: aggregateLinks(config, id) };
  });
  const ids = aggregateAccountIds(config);
  if (explicit(config) ? config.widgets.some(widget => widget.type === 'accounts') : ids.length) {
    const accountSections = Object.fromEntries(ids.map(id => [`account:${id}`, explicit(config)
      ? unique(config.widgets.filter(widget => widget.type === 'accounts' && widget.connection_ids.includes(id)).flatMap(widget => widget.sections))
      : legacySections(config, 'accounts', legacySections(config, `account:${id}`, ACCOUNT_DEFAULTS))]));
    rows.push({ id: 'accounts', type: 'accounts', name: '额度与余额', connection_ids: ids, sections: aggregateSections(config, 'accounts'), accountSections,
      accounts: ids.map(connection_id => ({ id: `account:${connection_id}`, type: 'account', connection_id, connection: connections.find(row => row.id === connection_id) || null })) });
  }
  return rows;
}
function nextId(config, name) {
  let i = 1, id = `widget:${name}`;
  while (config.widgets.some(widget => widget.id === id) || config.layout.some(cell => cell.id === id)) id = `widget:${name}-${i++}`;
  return id;
}
function append(config, type, name, project_id, sections, links = [], connection_ids = []) {
  const widget = { ...newWidget(type, nextId(config, name), project_id), sections: [...sections], links: structuredClone(links), connection_ids: [...connection_ids] };
  config.widgets.push(widget); return widget;
}
/** Only a navigation edit needs materialization. Never truncate sources, links, or disabled members. */
export function materializeAggregate(config, projects, { check = true } = {}) {
  if (explicit(config)) return;
  const ids = aggregateProjectIds(config, projects), accounts = aggregateAccountIds(config), links = globalLinks();
  const next = { ...config, widgets: [] };
  for (const id of ids) {
    const sections = aggregateSections(config, id);
    for (const type of projectTypes) append(next, type, `${id}-${type}`, id, WIDGET_SECTIONS[type].map(([key]) => key).filter(key => sections.includes(key)));
    append(next, 'shortcuts', `${id}-shortcuts`, null, sections.includes('shortcuts') ? ['shortcuts'] : [], projectLinks(id));
  }
  // Preserve per-account legacy content rather than replacing it with the union.
  for (const id of accounts) {
    const sections = legacySections(config, 'accounts', legacySections(config, `account:${id}`, ACCOUNT_DEFAULTS));
    const member = next.widgets.find(widget => widget.type === 'accounts' && JSON.stringify(widget.sections) === JSON.stringify(sections));
    if (member) member.connection_ids.push(id); else append(next, 'accounts', 'accounts', null, sections, [], [id]);
  }
  if (links.length) append(next, 'shortcuts', 'global-shortcuts', null, ['shortcuts'], links);
  if (check) validateWidgets(next.widgets);
  config.widgets = next.widgets;
}
export function selectAggregateProject(config, projects, id, selected) {
  if (!explicit(config)) {
    config.hidden_projects = selected ? config.hidden_projects.filter(value => value !== id) : unique([...config.hidden_projects, id]); return;
  }
  if (!selected) {
    config.widgets = config.widgets.filter(widget => widget.project_id !== id && !(widget.type === 'shortcuts' && widget.links.length && widget.links.every(link => link.scope === 'project' && link.project_id === id)));
    for (const widget of config.widgets) widget.links = widget.links.filter(link => link.project_id !== id);
  } else if (!aggregateProjectIds(config, projects).includes(id)) {
    for (const type of projectTypes) append(config, type, `${id}-${type}`, id, WIDGET_SECTIONS[type].map(([key]) => key));
    append(config, 'shortcuts', `${id}-shortcuts`, null, ['shortcuts'], projectLinks(id));
  }
}
export function selectAggregateAccounts(config, selected, addedSections = null) {
  if (!explicit(config)) { config.cards = selected.map(connection_id => ({ type: 'account', connection_id })); return; }
  const previous = aggregateAccountIds(config);
  const sections = addedSections ?? (config.widgets.some(widget => widget.type === 'accounts') ? aggregateSections(config, 'accounts') : ACCOUNT_DEFAULTS);
  config.widgets = config.widgets.filter(widget => widget.type !== 'accounts' || !widget.connection_ids.length || widget.connection_ids.some(id => selected.includes(id)));
  for (const widget of config.widgets.filter(widget => widget.type === 'accounts')) widget.connection_ids = widget.connection_ids.filter(id => selected.includes(id));
  const added = selected.filter(id => !previous.includes(id));
  if (added.length) {
    const member = config.widgets.find(widget => widget.type === 'accounts' && widget.connection_ids.length + added.length <= 100
      && widget.sections.length === sections.length && sections.every(section => widget.sections.includes(section)));
    if (member) member.connection_ids.push(...added); else append(config, 'accounts', 'accounts', null, sections, [], added);
  }
}
/** Split only a shared navigation member when a per-source content toggle requires it. */
function toggleLinkSection(config, predicate, selected) {
  for (const widget of [...config.widgets].filter(widget => widget.type === 'shortcuts')) {
    const matches = widget.links.filter(predicate);
    if (!matches.length || widget.sections.includes('shortcuts') === selected) continue;
    const other = widget.links.filter(link => !predicate(link));
    if (other.length) {
      widget.links = other;
      append(config, 'shortcuts', 'navigation', null, selected ? ['shortcuts'] : [], matches);
    } else widget.sections = selected ? ['shortcuts'] : [];
  }
}
export function toggleAggregateSection(config, id, section, selected) {
  if (!explicit(config)) {
    const sections = aggregateSections(config, id);
    config.content = [...config.content.filter(item => item.id !== id), { id, sections: selected ? unique([...sections, section]) : sections.filter(key => key !== section) }]; return;
  }
  if (section === 'shortcuts') {
    if (selected && !aggregateLinks(config, id, { selectedOnly: false }).length) append(config, 'shortcuts', `${id}-shortcuts`, null, ['shortcuts'], projectLinks(id));
    else toggleLinkSection(config, link => link.scope === 'project' && link.project_id === id, selected);
    return;
  }
  const type = id === 'accounts' ? 'accounts' : projectTypes.find(type => WIDGET_SECTIONS[type].some(([key]) => key === section));
  const members = config.widgets.filter(widget => widget.type === type && (id === 'accounts' || widget.project_id === id));
  if (!members.length && selected && id !== 'accounts') append(config, type, `${id}-${type}`, id, [section]);
  for (const widget of members) widget.sections = selected ? unique([...widget.sections, section]) : widget.sections.filter(key => key !== section);
}
export function toggleAggregateLink(config, projects, item, selected) {
  // Keep over-limit drafts editable; the explicit save validates before any request.
  materializeAggregate(config, projects, { check: false });
  const match = link => sameLink(link, item);
  if (!selected) {
    config.widgets = config.widgets.filter(widget => widget.type !== 'shortcuts' || !widget.links.length || !widget.links.every(match));
    for (const widget of config.widgets.filter(widget => widget.type === 'shortcuts')) widget.links = widget.links.filter(link => !match(link));
  } else if (aggregateLinks(config, item.project_id, { selectedOnly: false }).some(match)) {
    if (item.scope === 'global') toggleLinkSection(config, match, true);
  } else {
    const disabled = item.scope === 'project' && !aggregateSections(config, item.project_id).includes('shortcuts');
    const member = config.widgets.find(widget => widget.type === 'shortcuts' && widget.links.length < 24 && widget.sections.includes('shortcuts') !== disabled
      && widget.links.every(link => link.scope === item.scope && link.project_id === item.project_id));
    if (member) member.links.push(structuredClone(item)); else append(config, 'shortcuts', 'navigation', null, disabled ? [] : ['shortcuts'], [item]);
  }
}

/** Original 5px top border: 140px shell, independent of counts and text. */
export function aggregateBudget(sections, geometry = AGGREGATE_SIZES.project) {
  const body = Math.max(0, (Number.isFinite(geometry?.h) ? geometry.h : 24) * 24 - 140);
  let used = 0, groups = 0;
  const visible = [];
  // Two message rows remain the highest priority at the minimum 4x10 geometry.
  for (const [section, height] of [['messages', 92], ['metrics', 92], ['distribution', 44], ['delivery', 44]]) {
    if (!sections.includes(section) || used + (groups ? 6 : 0) + height > body) continue;
    used += (groups ? 6 : 0) + height; groups++; visible.push(section);
  }
  const remaining = Math.max(0, body - used - (groups ? 6 : 0));
  return { body, visible, workers: sections.includes('recent') ? Math.max(0, Math.min(12, Math.floor((remaining + 4) / 48))) : 0 };
}
