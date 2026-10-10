import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { check, isPlainObject, LushError } from './types.js';
import { acquireConfigurationLock } from './device-config.js';
import { normalizeRuntimeSettings } from './settings.js';
import { AgentSettings, AGENT_ROLES } from '../agent/settings.js';
import { AGENT_ENV_TARGETS, parseAgentEnv } from '../agent/environment.js';
import { readNetworkConfiguration } from '../agent/network.js';
import { QuickExplanationSettings } from './quick-explanation.js';
import { ConnectionFile } from '../agent/connections-file.js';
import { PROMPT_SUPPLEMENT_TARGETS, PRIVATE_PROMPT_MAX_BYTES } from '../agent/private-prompts.js';

// Revisions are process-private MACs, not publicly brute-forceable hashes of credentials/env.
// A daemon restart requires a fresh preview; the durable journal contains no secret digests.
const revisionKey = randomBytes(32);
const MAX_JSON = 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PHASES = new Set(['pending', 'published', 'retired', 'retained']);
const STATUS = new Set(['prepared', 'publishing', 'retiring', 'complete']);
const definitions = [
  { key: 'runtime', kind: '系统运行参数', relative: 'settings.json', max: 8192 },
  { key: 'agent', kind: 'Agent 配置', relative: 'agent.json', max: 256 * 1024 },
  { key: 'network', kind: '出站网络', relative: 'network.json', max: 65536 },
  { key: 'quick', kind: '快捷解释配置', relative: 'quick-explanation.json', max: 65536 },
  // Legacy common and the current agent role both resolve to agent/agent.env.
  // Migrate physical files once, not once per UI target/role alias.
  ...AGENT_ENV_TARGETS.filter((target, index, targets) => index === targets.findIndex(other =>
    (other === 'common' ? 'agent' : other) === (target === 'common' ? 'agent' : target)))
    .map(target => ({ key: `env-${target}`, kind: 'Agent 环境变量',
      relative: path.join('agent', target === 'common' ? 'agent.env' : `${target}.env`), max: 65536 })),
  ...PROMPT_SUPPLEMENT_TARGETS.map(target => ({ key: `prompt-${target}`, kind: `Agent 本机 Markdown 补充（${target}）`,
    relative: path.join('agent', `${target}.md`), max: PRIVATE_PROMPT_MAX_BYTES, retain: true })),
  { key: 'credentials', kind: '模型来源与凭证', relative: path.join('credentials', 'agent-connections.json'), max: MAX_JSON },
];
const byKey = new Map(definitions.map(definition => [definition.key, definition]));
const sign = value => createHmac('sha256', revisionKey).update(JSON.stringify(value)).digest('hex');
const stable = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
}
const equivalent = (a, b) => stable(a) === stable(b);
const serialize = value => JSON.stringify(value, null, 2) + '\n';
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const owner = stat => typeof process.getuid === 'function' && stat.uid === process.getuid();
const privateDir = stat => stat.isDirectory() && !stat.isSymbolicLink() && owner(stat) && (stat.mode & 0o777) === 0o700;
const error = message => new LushError(message);
function statMaybe(file) {
  try { return fs.lstatSync(file); } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
}
function directory(dir, create = false) {
  if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = statMaybe(dir);
  if (!stat) {
    let parent = path.dirname(dir);
    while (!statMaybe(parent)) parent = path.dirname(parent);
    check(fs.realpathSync(parent) === parent, 'unsafe migration ancestor');
    return null;
  }
  check(privateDir(stat) && fs.realpathSync(dir) === dir, 'unsafe migration directory');
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode };
}
function roots(config) {
  check(process.platform !== 'win32' && typeof process.getuid === 'function', 'unsupported migration platform');
  check(typeof config?.project === 'string' && path.isAbsolute(config.project)
    && fs.realpathSync(config.project) === config.project && fs.statSync(config.project).isDirectory(), 'invalid migration project');
  check(config.home === path.join(config.project, '.lush'), 'migration requires canonical project home');
  check(typeof config.deviceHome === 'string' && path.isAbsolute(config.deviceHome)
    && path.resolve(config.deviceHome) === config.deviceHome
    && config.deviceHome !== config.project && !config.deviceHome.startsWith(config.project + path.sep), 'invalid device migration home');
  return { project: directory(config.home), device: directory(config.deviceHome) };
}
function parentDirectories(home, relative, create = false) {
  const pieces = relative.split(path.sep).slice(0, -1);
  let dir = home; const identities = [];
  for (const piece of pieces) { dir = path.join(dir, piece); identities.push(directory(dir, create)); }
  return identities;
}
/** Bounded, no-follow snapshot with stable fd, file and parent identity. */
function readFile(home, relative, max = MAX_JSON) {
  const root = directory(home), parents = parentDirectories(home, relative);
  const file = path.join(home, relative), before = statMaybe(file);
  if (!before) return { body: null, fact: null };
  check(before.isFile() && !before.isSymbolicLink() && owner(before) && (before.mode & 0o777) === 0o600
    && before.nlink === 1 && before.size <= max, 'unsafe migration file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd); check(same(opened, before) && opened.mode === before.mode && opened.uid === before.uid
      && opened.nlink === 1 && opened.size === before.size && opened.mtimeMs === before.mtimeMs && opened.ctimeMs === before.ctimeMs, 'migration file changed');
    const buffer = Buffer.alloc(max + 1); let length = 0;
    for (;;) {
      const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
      length += n; check(length <= max, 'migration file too large');
      if (!n) break;
    }
    const after = fs.fstatSync(fd), current = fs.lstatSync(file);
    check(same(opened, after) && same(opened, current) && opened.size === after.size && opened.mtimeMs === after.mtimeMs
      && opened.ctimeMs === after.ctimeMs && opened.mode === current.mode && after.ctimeMs === current.ctimeMs
      && after.uid === current.uid && after.nlink === 1 && current.nlink === 1 && after.size === length, 'migration file changed');
    check(equivalent(root, directory(home)) && equivalent(parents, parentDirectories(home, relative)), 'migration directory changed');
    const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
    return { body, fact: { dev: current.dev, ino: current.ino, mode: current.mode, uid: current.uid, nlink: current.nlink,
      size: current.size, mtime: current.mtimeMs, ctime: current.ctimeMs, root, parents, content: sign(body) } };
  } finally { fs.closeSync(fd); }
}
function syncDirectory(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function atomicWrite(home, relative, body, max = MAX_JSON, beforePublish = () => {}) {
  check(Buffer.byteLength(body) <= max, 'migration output too large');
  directory(home, true); parentDirectories(home, relative, true);
  const destination = path.join(home, relative);
  const before = readFile(home, relative, max); // Reject unsafe destinations, including during recovery.
  const root = directory(home), parents = parentDirectories(home, relative);
  const temporary = path.join(path.dirname(destination), `.migration-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, body); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    check(equivalent(root, directory(home)), 'migration directory changed before publication');
    check(equivalent(parents, parentDirectories(home, relative)), 'migration directory changed before publication');
    check(equivalent(before.fact, readFile(home, relative, max).fact), 'migration destination changed before publication');
    beforePublish();
    fs.renameSync(temporary, destination); syncDirectory(path.dirname(destination));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  }
}
function fields(value, names) {
  check(isPlainObject(value) && Object.keys(value).every(key => names.includes(key)), 'invalid migration metadata');
}
function connectionFile(home) {
  // Trusted migration read only. Normal managers must fail closed while the source handoff marker exists.
  return new ConnectionFile(home, { privateRoot: true, migrationRead: true });
}
function resourcePaths(config, profile) {
  const resolve = value => {
    check(typeof value === 'string' && value && !value.includes('\0'), 'invalid migration resource');
    if (value === '~' || value.startsWith('~/')) {
      const home = config.env?.HOME || os.homedir();
      check(path.isAbsolute(home), 'invalid migration resource home');
      return path.resolve(home, value.slice(2));
    }
    return path.resolve(config.project, value);
  };
  return { ...profile, extensions: profile.extensions.map(resolve), skills: profile.skills.map(resolve) };
}
function normalizedValue(definition, config, home, snapshot, source = false) {
  if (snapshot.body === null) return null;
  if (definition.retain) return snapshot.body;
  if (definition.key.startsWith('env-')) return parseAgentEnv(snapshot.body, 'migration environment');
  const value = JSON.parse(snapshot.body);
  if (definition.key === 'runtime') return { version: 1, ...normalizeRuntimeSettings(value, 'migration runtime settings') };
  if (definition.key === 'agent') {
    const agent = new AgentSettings({ ...config, home, deviceHome: null }).readStored();
    for (const role of ['default', ...AGENT_ROLES]) {
      const profile = role === 'default' ? agent.default : agent.roles[role];
      if (!profile) continue;
      if (!source) check([...profile.extensions, ...profile.skills].every(value => path.isAbsolute(value)), 'relative device resource');
      const resolved = source ? resourcePaths(config, profile) : profile;
      if (role === 'default') agent.default = resolved; else agent.roles[role] = resolved;
    }
    return agent;
  }
  if (definition.key === 'network') {
    const view = readNetworkConfiguration({ home, deviceHome: null });
    return { version: 1, mode: view.mode, proxy_url: view.proxy_url, no_proxy: view.no_proxy,
      proxy_auth: view.has_proxy_auth ? value.proxy_auth : null };
  }
  if (definition.key === 'quick') return { version: 1, ...new QuickExplanationSettings({ home, deviceHome: null }).read() };
  if (definition.key === 'credentials') return connectionFile(home).read();
  throw new Error('invalid migration definition');
}
function normalized(definition, config, home, snapshot, source = false) {
  const value = normalizedValue(definition, config, home, snapshot, source);
  // Existing validators may reopen the file. Never attach their result to a different snapshot.
  check(equivalent(snapshot.fact, readFile(home, definition.relative, definition.max).fact), 'migration changed during validation');
  return value;
}
function sameConnection(a, b) {
  const { revision: ar, ...av } = a, { revision: br, ...bv } = b;
  return equivalent(av, bv);
}
function checkOAuthUniqueness(connections) {
  // Inspect the final UUID-deduplicated set, including source-only imports and existing target rows.
  // Exact accountId + refresh reuse is known double-active OAuth; names/providers are not account evidence.
  const credentials = new Set();
  for (const row of connections) {
    if (row.credential?.type !== 'oauth') continue;
    const key = JSON.stringify([row.credential.accountId, row.credential.refresh]);
    check(!credentials.has(key), 'duplicate OAuth credential'); credentials.add(key);
  }
}
function mergeConnections(source, target) {
  if (!target) { checkOAuthUniqueness(source.connections); return source; }
  check(equivalent(source.sampling, target.sampling), 'conflicting sampling');
  const byId = new Map(target.connections.map(row => [row.id, row]));
  for (const row of source.connections) {
    const existing = byId.get(row.id);
    check(!existing || sameConnection(existing, row), 'conflicting connection');
    if (!existing) byId.set(row.id, row);
  }
  check(byId.size <= 50, 'too many shared connections');
  const connections = [...byId.values()]; checkOAuthUniqueness(connections);
  return { version: 1, sampling: target.sampling, connections };
}
const stateRelative = path.join('device-migration', 'current.json');
const markerRelative = path.join('credentials', 'device-migration-active.json');
function journalRelative(id) { return path.join('device-migration', id, 'journal.json'); }
function backupHome(config, id) { return path.join(config.home, 'device-migration', id, 'files'); }
function loadState(config, facts) {
  const pointer = readFile(config.home, stateRelative, 65536); facts.pointer = pointer.fact;
  if (pointer.body === null) return null;
  const current = JSON.parse(pointer.body); fields(current, ['version', 'id']);
  check(current.version === 1 && UUID.test(current.id), 'invalid migration pointer');
  const snapshot = readFile(config.home, journalRelative(current.id), 65536); facts.journal = snapshot.fact;
  check(snapshot.body !== null, 'missing migration journal');
  const journal = JSON.parse(snapshot.body);
  fields(journal, ['version', 'id', 'status', 'project', 'device_home', 'entries', 'retained']);
  check(journal.version === 1 && journal.id === current.id && STATUS.has(journal.status)
    && journal.project === config.project && journal.device_home === config.deviceHome
    && Array.isArray(journal.entries) && journal.entries.length <= definitions.length, 'invalid migration journal');
  const keys = new Set();
  for (const entry of journal.entries) {
    fields(entry, ['key', 'phase']);
    check(byKey.has(entry.key) && !keys.has(entry.key) && PHASES.has(entry.phase)
      && (entry.phase !== 'retained' || byKey.get(entry.key).retain), 'invalid migration journal entry'); keys.add(entry.key);
  }
  // Completed Markdown provenance survives later JSON/env/OAuth migrations. Only fixed keys/UUIDs,
  // no contents or public digests, may select a previously verified private backup.
  if (journal.retained !== undefined) {
    check(Array.isArray(journal.retained) && journal.retained.length <= PROMPT_SUPPLEMENT_TARGETS.length, 'invalid retained migration metadata');
    const retainedKeys = new Set();
    for (const entry of journal.retained) {
      fields(entry, ['key', 'id']);
      check(byKey.get(entry.key)?.retain && !retainedKeys.has(entry.key) && typeof entry.id === 'string' && UUID.test(entry.id), 'invalid retained migration entry');
      retainedKeys.add(entry.key);
    }
  }
  return journal;
}
function lockPresent(home, relative) { return statMaybe(path.join(home, relative)) !== null; }
function checkLocks(config, entries, blockers) {
  for (const home of [config.home, config.deviceHome]) {
    if (lockPresent(home, '.settings-write.lock') || lockPresent(home, '.migration.lock') || lockPresent(home, '.packages.lock'))
      blockers.push('设置或资源操作正在进行，请稍后重新预检。');
    if (lockPresent(home, path.join('credentials', 'agent-connections.lock')))
      blockers.push('模型来源正在变更，请稍后重新预检。');
  }
  const credential = entries.find(entry => entry.definition.key === 'credentials');
  for (const row of credential?.value.connections || []) if (row.auth_type === 'oauth') {
    for (const home of [config.home, config.deviceHome]) if (lockPresent(home, path.join('credentials', `refresh-${row.id}.lock`)))
      blockers.push('OAuth 认证正在刷新，请稍后重新预检。');
  }
}
function plan(config, { ignoreLocks = false } = {}) {
  const rootFacts = roots(config), facts = { files: {} }, blockers = [], warnings = [], entries = [];
  check(rootFacts.project, 'project home is unavailable');
  const journal = loadState(config, facts);
  const marker = readFile(config.home, markerRelative, 65536); facts.marker = marker.fact;
  if (marker.body !== null) {
    const value = JSON.parse(marker.body); fields(value, ['version', 'id']);
    check(value.version === 1 && journal && value.id === journal.id, 'invalid migration handoff');
  }
  const active = new Map();
  for (const definition of definitions) {
    const source = readFile(config.home, definition.relative, definition.max);
    const destination = readFile(config.deviceHome, definition.relative, definition.max);
    facts.files[definition.key] = { source: source.fact, destination: destination.fact };
    if (source.body !== null) active.set(definition.key, source);
  }
  const recovering = journal && (journal.status !== 'complete' || marker.body !== null);
  for (const entry of journal?.retained || []) {
    const definition = byKey.get(entry.key), backup = readFile(backupHome(config, entry.id), definition.relative, definition.max);
    check(backup.body !== null, 'missing retained migration backup');
    facts.files[entry.key].completed_backup = backup.fact;
    // Retained originals are inactive history, not an implicit authorization to resurrect a device file.
    const pendingHere = recovering && journal.entries.some(row => row.key === entry.key);
    if (!pendingHere && active.get(entry.key)?.body === backup.body) active.delete(entry.key);
  }
  const already = journal?.status === 'complete' && !recovering && active.size === 0;
  if (already) return { config, roots: rootFacts, facts, entries, journal, marker, already: true, recovering: false, blockers, warnings };
  if (recovering) {
    warnings.push('存在未完成迁移；本次确认只按已核验的备份和磁盘事实继续，不自动重放。');
    check([...active.keys()].every(key => journal.entries.some(entry => entry.key === key)), 'new config after interrupted migration');
  }
  const selected = recovering ? journal.entries.map(entry => byKey.get(entry.key)) : definitions.filter(definition => active.has(definition.key));
  for (const definition of selected) {
    try {
      const backup = recovering ? readFile(backupHome(config, journal.id), definition.relative, definition.max) : null;
      if (recovering) { check(backup.body !== null, 'missing migration backup'); facts.files[definition.key].backup = backup.fact; }
      const original = recovering ? backup : active.get(definition.key);
      const source = active.get(definition.key) || { body: null, fact: null };
      check(source.body === null || !recovering || source.body === original.body, 'source changed after interrupted migration');
      const originalHome = recovering ? backupHome(config, journal.id) : config.home;
      const value = normalized(definition, config, originalHome, original, true);
      const destination = readFile(config.deviceHome, definition.relative, definition.max);
      const target = normalized(definition, config, config.deviceHome, destination);
      const output = definition.key === 'credentials' ? mergeConnections(value, target) : value;
      if (definition.key !== 'credentials') check(target === null || equivalent(target, output), 'conflicting device configuration');
      // If a source is already gone, only verified publication can justify continuing retirement.
      check(source.body !== null || !definition.retain && target !== null && equivalent(target, output), 'unverified retired source');
      const body = definition.retain || definition.key.startsWith('env-') ? original.body : serialize(output);
      check(Buffer.byteLength(body) <= definition.max, 'migration output too large');
      entries.push({ definition, original, source, destination, value, output, body,
        action: definition.retain ? (target !== null ? '复用设备补充，保留不活跃的项目原件' : '导入设备补充，保留不活跃的项目原件')
          : source.body === null ? '已退役，核验完成' : target !== null && equivalent(target, output) ? '复用共享配置并退役项目覆盖' : '导入共享配置并退役项目覆盖' });
    } catch { blockers.push(`${definition.kind}存在冲突或无法安全读取；请先处理再重新预检。`); }
  }
  if (selected.some(definition => definition.retain)) warnings.push('本机 Markdown 补充将影响同一设备的所有项目后续调用；仓库专属约定应保留在 .lush-agent/ 或 AGENTS.md。导入后保留旧项目原件，但不再参与调用。');
  if (statMaybe(path.join(config.home, 'pi'))) warnings.push('原项目 Pi 安装库保留；已配置资源路径转为原项目绝对路径，新安装请使用设备共享库。');
  if (!selected.length && !recovering) warnings.push('当前项目没有可迁移的设置；没有扫描其他项目。');
  if (!ignoreLocks) checkLocks(config, entries, blockers);
  return { config, roots: rootFacts, facts, entries, journal, marker, already: false, recovering: Boolean(recovering), blockers: [...new Set(blockers)], warnings };
}
function publicItems(config, entries) {
  return entries.map(entry => ({ kind: entry.definition.kind, source: path.join(config.home, entry.definition.relative),
    destination: path.join(config.deviceHome, entry.definition.relative), action: entry.action }));
}
function revision(plan) { return sign({ project: plan.config.project, home: plan.config.home, device: plan.config.deviceHome, roots: plan.roots, facts: plan.facts }); }
export function previewDeviceMigration(config) {
  try {
    const value = plan(config);
    return { version: 1, revision: revision(value), can_migrate: value.blockers.length === 0,
      blockers: value.blockers, items: publicItems(config, value.entries), warnings: value.warnings, already_migrated: value.already };
  } catch {
    return { version: 1, revision: sign('invalid migration preview'), can_migrate: false,
      blockers: ['项目、设备目录或迁移记录无法安全读取；未修改任何配置。'], items: [], warnings: [], already_migrated: false };
  }
}
function writeJournal(config, journal) { atomicWrite(config.home, journalRelative(journal.id), serialize(journal), 65536); }
function rootUnchanged(before, after) {
  return before === null ? after === null || isPlainObject(after) : after && equivalent(before, after);
}
function assertCurrent(entry, config, side) {
  const home = side === 'source' ? config.home : config.deviceHome;
  const current = readFile(home, entry.definition.relative, entry.definition.max);
  check(equivalent(current.fact, entry[side].fact), 'migration file changed after confirmation');
  return current;
}
function acquireCredentialLocks(config, entries, locks) {
  const credential = entries.find(entry => entry.definition.key === 'credentials');
  if (!credential) return;
  const files = [connectionFile(config.home), connectionFile(config.deviceHome)];
  for (const file of files) locks.push(file.lock('agent-connections.lock'));
  for (const row of credential.value.connections) if (row.auth_type === 'oauth')
    for (const file of files) locks.push(file.lock(`refresh-${row.id}.lock`));
}
/** Explicit, synchronous handoff. Publication is recoverable and source credentials are fail-closed until retirement completes. */
export function migrateDeviceSettings(config, options) {
  fields(options, ['revision', 'confirm']);
  if (options.confirm !== true || typeof options.revision !== 'string' || !/^[a-f0-9]{64}$/.test(options.revision))
    throw error('设备设置迁移需要重新预检并确认。');
  let initial;
  try { initial = plan(config); } catch { throw error('项目、设备目录或迁移记录无法安全读取；未开始迁移。'); }
  const expected = revision(initial);
  if (!timingSafeEqual(Buffer.from(options.revision, 'hex'), Buffer.from(expected, 'hex')))
    throw error('迁移预检已过期，请重新预检。');
  if (initial.blockers.length) throw error('设备设置存在冲突、不安全文件或忙碌操作，未开始迁移。');
  if (initial.already) return { version: 1, migrated: false, already_migrated: true,
    backup: path.join(config.home, 'device-migration', initial.journal.id, 'files'), items: [], warnings: initial.warnings };
  if (!initial.entries.length && !initial.recovering) return { version: 1, migrated: false, already_migrated: false,
    backup: null, items: [], warnings: initial.warnings };
  const locks = []; let started = false;
  try {
    locks.push(acquireConfigurationLock(config, 'project'));
    locks.push(acquireConfigurationLock(config, 'device'));
    locks.push(acquireConfigurationLock(config, 'project', 'migration'));
    acquireCredentialLocks(config, initial.entries, locks);
    let current = plan(config, { ignoreLocks: true });
    check(rootUnchanged(initial.roots.project, current.roots.project) && rootUnchanged(initial.roots.device, current.roots.device)
      && equivalent(initial.facts, current.facts) && !current.blockers.length, 'migration changed during lock acquisition');
    let journal = current.recovering ? current.journal : { version: 1, id: randomUUID(), status: 'prepared',
      project: config.project, device_home: config.deviceHome,
      entries: current.entries.map(entry => ({ key: entry.definition.key, phase: 'pending' })) };
    if (!current.recovering) {
      const retained = new Map((current.journal?.retained || []).map(entry => [entry.key, entry]));
      for (const entry of current.entries) if (entry.definition.retain) retained.set(entry.definition.key, { key: entry.definition.key, id: journal.id });
      if (retained.size) journal.retained = [...retained.values()];
      const backup = backupHome(config, journal.id); directory(backup, true);
      for (const entry of current.entries) atomicWrite(backup, entry.definition.relative, entry.original.body, entry.definition.max);
      writeJournal(config, journal);
      atomicWrite(config.home, stateRelative, serialize({ version: 1, id: journal.id }), 65536);
    }
    started = true;
    const backupFacts = new Map();
    const trackBackup = (id, definition, body) => {
      const home = backupHome(config, id), snapshot = readFile(home, definition.relative, definition.max);
      check(snapshot.body !== null && (body === undefined || snapshot.body === body), 'migration backup changed');
      backupFacts.set(path.join(home, definition.relative), { home, definition, fact: snapshot.fact });
    };
    for (const entry of current.entries) trackBackup(journal.id, entry.definition, entry.original.body);
    for (const retained of journal.retained || []) if (!current.entries.some(entry => entry.definition.key === retained.key))
      trackBackup(retained.id, byKey.get(retained.key));
    if (current.entries.some(entry => entry.definition.key === 'credentials') && current.marker.body === null)
      atomicWrite(config.home, markerRelative, serialize({ version: 1, id: journal.id }), 65536);
    journal.status = 'publishing'; writeJournal(config, journal);
    const publicationFacts = new Map();
    for (const entry of current.entries) {
      for (const lock of locks) lock.assert();
      assertCurrent(entry, config, 'source');
      assertCurrent(entry, config, 'destination');
      const checkpoint = journal.entries.find(row => row.key === entry.definition.key);
      const target = normalized(entry.definition, config, config.deviceHome, entry.destination);
      if (target === null || !equivalent(target, entry.output)) atomicWrite(config.deviceHome, entry.definition.relative, entry.body, entry.definition.max, () => {
        for (const lock of locks) lock.assert();
        assertCurrent(entry, config, 'source');
      });
      const published = readFile(config.deviceHome, entry.definition.relative, entry.definition.max);
      check(equivalent(normalized(entry.definition, config, config.deviceHome, published), entry.output), 'device publication changed');
      publicationFacts.set(entry.definition.key, published.fact);
      checkpoint.phase = 'published'; writeJournal(config, journal);
    }
    journal.status = 'retiring'; writeJournal(config, journal);
    for (const entry of current.entries) {
      for (const lock of locks) lock.assert();
      const target = readFile(config.deviceHome, entry.definition.relative, entry.definition.max);
      check(equivalent(target.fact, publicationFacts.get(entry.definition.key))
        && equivalent(normalized(entry.definition, config, config.deviceHome, target), entry.output), 'device publication changed before retirement');
      assertCurrent(entry, config, 'source');
      if (entry.source.body !== null && !entry.definition.retain) {
        fs.unlinkSync(path.join(config.home, entry.definition.relative));
        syncDirectory(path.dirname(path.join(config.home, entry.definition.relative)));
      }
      journal.entries.find(row => row.key === entry.definition.key).phase = entry.definition.retain ? 'retained' : 'retired'; writeJournal(config, journal);
    }
    const verifyDelivery = () => {
      for (const lock of locks) lock.assert();
      for (const { home, definition, fact } of backupFacts.values())
        check(equivalent(readFile(home, definition.relative, definition.max).fact, fact), 'migration backup changed');
      for (const entry of current.entries) {
        if (entry.definition.retain) assertCurrent(entry, config, 'source');
        else check(readFile(config.home, entry.definition.relative, entry.definition.max).body === null, 'source configuration reappeared');
        const target = readFile(config.deviceHome, entry.definition.relative, entry.definition.max);
        check(equivalent(target.fact, publicationFacts.get(entry.definition.key))
          && equivalent(normalized(entry.definition, config, config.deviceHome, target), entry.output), 'device terminal publication changed');
      }
    };
    // Do not mark retained Markdown complete before checking its originals and private backups.
    verifyDelivery();
    journal.status = 'complete'; writeJournal(config, journal);
    // A successful write is not sufficient authority to remove the source credential guard.
    // Re-read the durable delivery record and both sides of every handoff at the final boundary.
    check(equivalent(loadState(config, {}), journal), 'migration terminal journal changed');
    verifyDelivery();
    const marker = readFile(config.home, markerRelative, 65536);
    if (marker.body !== null) {
      const value = JSON.parse(marker.body); fields(value, ['version', 'id']);
      check(value.version === 1 && value.id === journal.id, 'migration handoff changed');
      fs.unlinkSync(path.join(config.home, markerRelative)); syncDirectory(path.join(config.home, 'credentials'));
    }
    return { version: 1, migrated: true, already_migrated: false, backup: backupHome(config, journal.id),
      items: publicItems(config, current.entries), warnings: current.warnings };
  } catch {
    throw error(started ? '设备设置迁移未完成；原文件及已写入的私有备份保留，请重新预检以恢复。'
      : '设备设置迁移未开始或准备失败；未退役项目配置，请稍后重新预检。');
  } finally {
    for (const lock of locks.reverse()) { try { lock.release(); } catch { /* Never steal or remove replaced locks. */ } }
  }
}
