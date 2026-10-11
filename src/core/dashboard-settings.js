import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { check, isPlainObject } from './types.js';
import { validateConfigurationDirectory, withConfigurationWriteLock } from './device-config.js';

const MAX_BYTES = 16384;
const MAX_CARDS = 100;
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

/** Only selection identities belong here: never credentials, observations, project switches or layout. */
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
function load(config) {
  let fd;
  try {
    if (!validateConfigurationDirectory(config)) return [];
    const file = path.join(config.home, 'dashboard.json'), root = fs.lstatSync(config.home);
    let published;
    try { published = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
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
    const data = JSON.parse(source); fields(data, ['version', 'cards']);
    check(data.version === 1, 'invalid dashboard version');
    return normalizeDashboardCards(data.cards);
  } catch { throw new Error('dashboard settings cannot be safely read'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function model(cards) {
  return { version: 1, revision: createHash('sha256').update(JSON.stringify(cards)).digest('hex'), cards };
}

/** Read without creating the device root or validating sources through credential storage/network. */
export function readDashboardSettings(config) { return model(load(rootConfig(config))); }

/** Replace the selected accounts; deleted source identities remain valid placeholders. */
export function saveDashboardSettings(config, cards, expectedRevision) {
  const selected = rootConfig(config), normalized = normalizeDashboardCards(cards);
  check(typeof expectedRevision === 'string' && /^[a-f0-9]{64}$/.test(expectedRevision), 'dashboard revision is required');
  return withConfigurationWriteLock(selected, 'project', lock => {
    const current = model(load(selected));
    check(current.revision === expectedRevision, 'dashboard revision changed; reload before saving');
    const file = path.join(selected.home, 'dashboard.json');
    const source = JSON.stringify({ version: 1, cards: normalized }, null, 2) + '\n';
    check(Buffer.byteLength(source) <= MAX_BYTES, 'dashboard settings are too large');
    const temporary = `${file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, source); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      lock.assert();
      check(model(load(selected)).revision === current.revision, 'dashboard changed before publication');
      fs.renameSync(temporary, file);
      return model(normalized);
    } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temporary, { force: true }); }
  });
}
