import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { check, isPlainObject } from './types.js';
import { validateConfigurationDirectory, withConfigurationWriteLock } from './device-config.js';

const MAX_BYTES = 256 * 1024;
const MAX_CARDS = 100;
const MAX_ITEMS = 300;
const V2_FIELDS = ['cards', 'hidden_projects', 'layout', 'content'];
const V3_FIELDS = [...V2_FIELDS, 'account_view'];
const V4_FIELDS = [...V3_FIELDS, 'widgets'];
const PATCH_FIELDS = [...V4_FIELDS, 'diagnostics'];
const PROJECT_ID = /^[a-f0-9]{16}$/;
const PROJECT_SECTIONS = ['metrics', 'distribution', 'delivery', 'recent', 'messages', 'shortcuts'];
const ACCOUNT_SECTIONS = ['quota', 'balance', 'reset', 'observed', 'details', 'history', 'provenance'];
const WIDGET_ID = /^widget:[a-z0-9][a-z0-9-]{0,79}$/;
const WIDGET_SECTIONS = { status: ['metrics', 'distribution', 'delivery'], messages: ['messages'], workers: ['recent'],
  accounts: ACCOUNT_SECTIONS, shortcuts: ['shortcuts'] };
const GLOBAL_TARGETS = ['notices', 'project-management', 'model-sources', 'settings', 'agent-status', 'automation', 'docs'];
const PROJECT_TARGETS = ['workers', 'inputs', 'versions', 'notices'];
const empty = () => ({ version: 5, cards: [], hidden_projects: [], layout: [], content: [], account_view: 'list', widgets: null, diagnostics: true });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
function fields(value, allowed) {
  check(isPlainObject(value) && Object.keys(value).every(key => allowed.includes(key))
    && allowed.every(key => Object.hasOwn(value, key)), 'invalid dashboard fields');
}
function rootConfig(config) {
  const home = config?.deviceHome || config?.home;
  check(typeof home === 'string' && path.isAbsolute(home), 'dashboard directory is unavailable');
  return { home: path.resolve(home) };
}

/** Account selection stores only source identities, never credentials or observations. */
export function normalizeDashboardCards(cards) {
  check(Array.isArray(cards) && cards.length <= MAX_CARDS, 'dashboard cards must be an array of at most 100 accounts');
  const result = [], seen = new Set();
  for (const card of cards) {
    fields(card, ['type', 'connection_id']);
    check(card.type === 'account' && typeof card.connection_id === 'string' && UUID.test(card.connection_id),
      'dashboard account requires a connection UUID');
    const connection_id = card.connection_id.toLowerCase();
    if (seen.has(connection_id)) continue;
    seen.add(connection_id); result.push({ type: 'account', connection_id });
  }
  return result;
}
/** Independent cards contain only source identities and allow missing/deleted sources. */
export function normalizeDashboardWidgets(widgets) {
  if (widgets === null) return null; // Read-only legacy projection, distinct from an explicitly empty board.
  check(Array.isArray(widgets) && widgets.length <= MAX_CARDS, 'dashboard widgets must be null or an array of at most 100 cards');
  const seen = new Set();
  return Array.from(widgets, widget => {
    fields(widget, ['id', 'type', 'project_id', 'connection_ids', 'links', 'sections']);
    const { id, type, project_id } = widget;
    check(typeof id === 'string' && WIDGET_ID.test(id), 'invalid dashboard widget identity');
    check(!seen.has(id), 'duplicate dashboard widget identity');
    seen.add(id);
    check(typeof type === 'string' && Object.hasOwn(WIDGET_SECTIONS, type), 'invalid dashboard widget type');
    const projectCard = ['status', 'messages', 'workers'].includes(type);
    check(projectCard ? typeof project_id === 'string' && PROJECT_ID.test(project_id) : project_id === null,
      'invalid dashboard widget project identity');
    check(Array.isArray(widget.connection_ids) && widget.connection_ids.length <= (type === 'accounts' ? 100 : 0),
      'invalid dashboard widget connections');
    const connection_ids = [...new Set(Array.from(widget.connection_ids, connection => {
      check(typeof connection === 'string' && UUID.test(connection), 'dashboard widget requires a connection UUID');
      return connection.toLowerCase();
    }))];
    check(Array.isArray(widget.links) && widget.links.length <= (type === 'shortcuts' ? 24 : 0), 'invalid dashboard widget links');
    const links = Array.from(widget.links, link => {
      fields(link, ['scope', 'target', 'project_id']);
      check(link.scope === 'global' || link.scope === 'project', 'invalid dashboard shortcut scope');
      check(typeof link.target === 'string' && (link.scope === 'global' ? GLOBAL_TARGETS : PROJECT_TARGETS).includes(link.target),
        'invalid dashboard shortcut target');
      check(link.scope === 'global' ? link.project_id === null : typeof link.project_id === 'string' && PROJECT_ID.test(link.project_id),
        'invalid dashboard shortcut project identity');
      return { scope: link.scope, target: link.target, project_id: link.project_id };
    });
    check(Array.isArray(widget.sections), 'invalid dashboard widget sections');
    for (const section of widget.sections) {
      check(typeof section === 'string' && WIDGET_SECTIONS[type].includes(section), 'invalid dashboard widget sections');
    }
    return { id, type, project_id, connection_ids, links, sections: [...new Set(widget.sections)] };
  });
}
function layoutIdentity(value) {
  return typeof value === 'string' && WIDGET_ID.test(value) ? value : identity(value);
}
function identity(value) {
  check(typeof value === 'string' && (value === 'accounts' || PROJECT_ID.test(value)
    || (value.startsWith('account:') && UUID.test(value.slice(8)))), 'invalid dashboard card identity');
  return value.toLowerCase();
}
function items(value, name) {
  check(Array.isArray(value) && value.length <= MAX_ITEMS, `dashboard ${name} must be an array of at most 300 items`);
}
function uniqueRows(value, name, normalize) {
  items(value, name);
  const seen = new Set(), result = [];
  for (const row of value) {
    const normalized = normalize(row);
    check(!seen.has(normalized.id), `duplicate dashboard ${name} identity`);
    seen.add(normalized.id);
    result.push(normalized);
  }
  return result;
}
function integer(value, min, max) { return Number.isInteger(value) && value >= min && value <= max; }

/** Strict partial patch; omitted fields remain authoritative at publication time. */
export function normalizeDashboardPatch(patch) {
  check(isPlainObject(patch) && Object.keys(patch).length > 0
    && Object.keys(patch).every(key => PATCH_FIELDS.includes(key)), 'invalid dashboard patch fields');
  const result = {};
  if (Object.hasOwn(patch, 'cards')) result.cards = normalizeDashboardCards(patch.cards);
  if (Object.hasOwn(patch, 'hidden_projects')) {
    items(patch.hidden_projects, 'hidden_projects');
    for (const id of patch.hidden_projects) {
      check(typeof id === 'string' && PROJECT_ID.test(id), 'invalid dashboard hidden project identity');
    }
    result.hidden_projects = [...new Set(patch.hidden_projects)];
  }
  if (Object.hasOwn(patch, 'layout')) result.layout = uniqueRows(patch.layout, 'layout', row => {
    fields(row, ['id', 'x', 'y', 'w', 'h']);
    const id = layoutIdentity(row.id), { x, y, w, h } = row;
    check(integer(x, 0, 11) && integer(y, 0, 4095) && integer(w, 1, 12) && x + w <= 12
      && integer(h, 6, 80), 'invalid dashboard layout geometry');
    return { id, x, y, w, h };
  });
  if (Object.hasOwn(patch, 'content')) result.content = uniqueRows(patch.content, 'content', row => {
    fields(row, ['id', 'sections']);
    const id = identity(row.id), allowed = id === 'accounts' || id.startsWith('account:') ? ACCOUNT_SECTIONS : PROJECT_SECTIONS;
    check(Array.isArray(row.sections), 'invalid dashboard content sections');
    for (const section of row.sections) {
      check(typeof section === 'string' && allowed.includes(section), 'invalid dashboard content sections');
    }
    return { id, sections: [...new Set(row.sections)] };
  });
  if (Object.hasOwn(patch, 'diagnostics')) {
    check(typeof patch.diagnostics === 'boolean', 'invalid dashboard diagnostics');
    result.diagnostics = patch.diagnostics;
  }
  if (Object.hasOwn(patch, 'widgets')) result.widgets = normalizeDashboardWidgets(patch.widgets);
  if (Object.hasOwn(patch, 'account_view')) {
    check(patch.account_view === 'list' || patch.account_view === 'tiles', 'invalid dashboard account_view');
    result.account_view = patch.account_view;
  }
  return result;
}
function load(config) {
  let fd;
  try {
    if (!validateConfigurationDirectory(config)) return empty();
    const file = path.join(config.home, 'dashboard.json'), root = fs.lstatSync(config.home);
    let published;
    try { published = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
    check(!published.isSymbolicLink(), 'unsafe dashboard file');
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600
      && stat.nlink === 1 && stat.size <= MAX_BYTES && same(stat, published), 'unsafe dashboard file');
    const source = fs.readFileSync(fd, 'utf8'), after = fs.fstatSync(fd);
    check(Buffer.byteLength(source) <= MAX_BYTES && same(stat, after) && stat.size === after.size
      && stat.mtimeMs === after.mtimeMs && stat.ctimeMs === after.ctimeMs
      && same(stat, fs.lstatSync(file)) && same(root, fs.lstatSync(config.home)), 'dashboard changed while reading');
    validateConfigurationDirectory(config, 'project', true);
    const data = JSON.parse(source);
    if (data.version === 1) {
      fields(data, ['version', 'cards']);
      return { ...empty(), cards: normalizeDashboardCards(data.cards) };
    }
    check([2, 3, 4, 5].includes(data.version), 'invalid dashboard version');
    fields(data, ['version', ...(data.version === 2 ? V2_FIELDS : data.version === 3 ? V3_FIELDS : data.version === 4 ? V4_FIELDS : PATCH_FIELDS)]);
    const { version, ...patch } = data;
    const normalized = normalizeDashboardPatch(patch);
    // Old documents retain their own strict identity rules; reading is not a migration.
    if (version < 4) for (const row of normalized.layout) identity(row.id);
    return { ...empty(), ...normalized };
  } catch { throw new Error('dashboard settings cannot be safely read'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function model(settings) {
  return { ...settings, revision: createHash('sha256').update(JSON.stringify(settings)).digest('hex') };
}

/** Read without creating the device root or validating sources through credential storage/network. */
export function readDashboardSettings(config) { return model(load(rootConfig(config))); }

/** Atomically patch the board. Legacy array calls update only accounts; deleted identities remain placeholders. */
export function saveDashboardSettings(config, patchOrCards, expectedRevision) {
  const selected = rootConfig(config), normalized = normalizeDashboardPatch(
    Array.isArray(patchOrCards) ? { cards: patchOrCards } : patchOrCards);
  check(typeof expectedRevision === 'string' && /^[a-f0-9]{64}$/.test(expectedRevision), 'dashboard revision is required');
  return withConfigurationWriteLock(selected, 'project', lock => {
    const settings = load(selected), current = model(settings);
    check(current.revision === expectedRevision, 'dashboard revision changed; reload before saving');
    const next = { ...settings, ...normalized };
    const file = path.join(selected.home, 'dashboard.json');
    const source = JSON.stringify(next, null, 2) + '\n';
    check(Buffer.byteLength(source) <= MAX_BYTES, 'dashboard settings are too large');
    const temporary = `${file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, source); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      lock.assert();
      check(model(load(selected)).revision === current.revision, 'dashboard changed before publication');
      fs.renameSync(temporary, file);
      return model(next);
    } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temporary, { force: true }); }
  });
}
