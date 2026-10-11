import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { check, isPlainObject } from './types.js';
import { validateConfigurationDirectory, withConfigurationWriteLock } from './device-config.js';

const MAX_BYTES = 256 * 1024;
const MAX_CARDS = 100;
const MAX_ITEMS = 300;
const V2_FIELDS = ['cards', 'hidden_projects', 'layout', 'content'];
const PATCH_FIELDS = [...V2_FIELDS, 'account_view'];
const PROJECT_ID = /^[a-f0-9]{16}$/;
const PROJECT_SECTIONS = ['metrics', 'distribution', 'delivery', 'recent', 'messages', 'shortcuts'];
const ACCOUNT_SECTIONS = ['quota', 'balance', 'reset', 'observed', 'details', 'history', 'provenance'];
const empty = () => ({ version: 3, cards: [], hidden_projects: [], layout: [], content: [], account_view: 'list' });
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
    const id = identity(row.id), { x, y, w, h } = row;
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
    if (data.version === 2) {
      fields(data, ['version', ...V2_FIELDS]);
      const { version, ...patch } = data;
      return { ...empty(), ...normalizeDashboardPatch(patch) };
    }
    fields(data, ['version', ...PATCH_FIELDS]);
    check(data.version === 3, 'invalid dashboard version');
    const { version, ...patch } = data;
    return { version, ...normalizeDashboardPatch(patch) };
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
