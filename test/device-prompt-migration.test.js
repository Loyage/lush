import { test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from './helpers.js';
import { previewDeviceMigration, migrateDeviceSettings } from '../src/core/device-migration.js';
import { agentPrompt } from '../src/agent/prompts.js';
import { PROMPT_SUPPLEMENT_TARGETS } from '../src/agent/private-prompts.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = temp(); roots.push(root);
  const configs = ['a', 'b'].map(name => {
    const project = path.join(root, name), home = path.join(project, '.lush');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    return { project, home, deviceHome: path.join(root, 'device', 'shared'), env: { HOME: root } };
  });
  return { root, a: configs[0], b: configs[1] };
}
function write(home, relative, body) {
  const file = path.join(home, relative); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, body, { mode: 0o600 }); return file;
}
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const noContents = value => expect(JSON.stringify(value)).not.toContain('PRIVATE-MARKDOWN');
function apply(config, preview = previewDeviceMigration(config)) {
  expect(preview.can_migrate).toBe(true);
  return migrateDeviceSettings(config, { revision: preview.revision, confirm: true });
}
function journal(config) {
  const pointer = json(path.join(config.home, 'device-migration/current.json'));
  return { file: path.join(config.home, 'device-migration', pointer.id, 'journal.json'), id: pointer.id };
}
function inject(method, match, callback) {
  const original = fs[method]; let fired = false;
  fs[method] = function (...args) {
    if (!fired && match(...args)) { fired = true; return callback(original.bind(this), ...args); }
    return original.apply(this, args);
  };
  return { restore() { fs[method] = original; }, fired() { return fired; } };
}

test('Markdown preview is read-only, fixed to supported private files, warns of all-project effects and does not echo contents', () => {
  const f = fixture();
  for (const target of PROMPT_SUPPLEMENT_TARGETS) write(f.a.home, `agent/${target}.md`, `PRIVATE-MARKDOWN ${target}`);
  for (const relative of ['agent/README.md', 'agent/unknown.md', 'agent/scheduler.md']) write(f.a.home, relative, 'PRIVATE-MARKDOWN excluded');
  write(f.a.project, '.lush-agent/common.md', 'PRIVATE-MARKDOWN repository');
  write(f.a.project, 'AGENTS.md', 'PRIVATE-MARKDOWN repository contract');
  const preview = previewDeviceMigration(f.a);
  expect(preview.can_migrate).toBe(true); expect(preview.items).toHaveLength(PROMPT_SUPPLEMENT_TARGETS.length);
  expect(preview.items.map(item => path.basename(item.source))).toEqual(PROMPT_SUPPLEMENT_TARGETS.map(target => `${target}.md`));
  expect(preview.warnings.join(' ')).toContain('所有项目后续调用'); noContents(preview);
  expect(fs.existsSync(f.a.deviceHome)).toBe(false); expect(fs.existsSync(path.join(f.a.home, 'device-migration'))).toBe(false);
});

test('explicit Markdown migration preserves exact private originals/backups and repository isolation; repeat cannot resurrect a deleted device file', () => {
  const f = fixture(), body = '\ufeffPRIVATE-MARKDOWN personal\n  exact whitespace  \n';
  const source = write(f.a.home, 'agent/common.md', body), before = fs.statSync(source);
  write(f.a.home, 'agent/worker.md', 'PRIVATE-MARKDOWN worker');
  write(f.b.home, 'agent/common.md', 'PRIVATE-MARKDOWN inactive B');
  write(f.a.project, '.lush-agent/common.md', 'REPOSITORY A'); write(f.b.project, '.lush-agent/common.md', 'REPOSITORY B');
  const result = apply(f.a); noContents(result);
  for (const home of [f.a.home, f.a.deviceHome, result.backup]) {
    const file = path.join(home, 'agent/common.md'); expect(fs.readFileSync(file, 'utf8')).toBe(body);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600); expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  }
  expect(fs.statSync(source).ino).toBe(before.ino); expect(fs.statSync(source).mtimeMs).toBe(before.mtimeMs);
  const record = json(journal(f.a).file); noContents(record);
  expect(record.entries.every(row => row.phase === 'retained')).toBe(true); expect(record.retained).toHaveLength(2);
  for (const [config, own, other] of [[f.a, 'REPOSITORY A', 'REPOSITORY B'], [f.b, 'REPOSITORY B', 'REPOSITORY A']]) {
    const text = agentPrompt(config, 'worker').text;
    expect(text).toContain(own); expect(text).not.toContain(other);
    expect(text).toContain('PRIVATE-MARKDOWN personal'); expect(text).not.toContain('inactive B');
  }
  fs.unlinkSync(path.join(f.a.deviceHome, 'agent/common.md'));
  expect(previewDeviceMigration(f.a)).toMatchObject({ already_migrated: true, items: [] });
  expect(apply(f.a)).toMatchObject({ migrated: false, already_migrated: true, backup: result.backup });
  expect(fs.existsSync(path.join(f.a.deviceHome, 'agent/common.md'))).toBe(false);
  // Later ordinary migrations must carry the completed Markdown provenance without reimporting it.
  write(f.a.home, 'settings.json', '{"version":1,"concurrency":3}');
  expect(previewDeviceMigration(f.a).items).toHaveLength(1); expect(apply(f.a).migrated).toBe(true);
  expect(json(journal(f.a).file).retained).toEqual(record.retained);
  expect(fs.existsSync(path.join(f.a.home, 'settings.json'))).toBe(false);
  expect(fs.readFileSync(source, 'utf8')).toBe(body); expect(apply(f.a).already_migrated).toBe(true);
  expect(fs.existsSync(path.join(f.a.deviceHome, 'agent/common.md'))).toBe(false);
});

test('exact same Markdown (including empty files) reuses the target; different text or whitespace blocks all publication', () => {
  for (const body of ['', 'PRIVATE-MARKDOWN same\n']) {
    const f = fixture(); write(f.a.home, 'agent/common.md', body);
    const target = write(f.a.deviceHome, 'agent/common.md', body), before = fs.statSync(target);
    const result = apply(f.a); expect(result.items[0].action).toContain('复用'); expect(fs.statSync(target).ino).toBe(before.ino);
    expect(fs.readFileSync(path.join(f.a.home, 'agent/common.md'), 'utf8')).toBe(body);
  }
  for (const body of ['PRIVATE-MARKDOWN different', 'PRIVATE-MARKDOWN same\n ']) {
    const f = fixture(); write(f.a.home, 'agent/common.md', 'PRIVATE-MARKDOWN same\n');
    const target = write(f.a.deviceHome, 'agent/common.md', body); write(f.a.home, 'settings.json', '{"concurrency":3}');
    const preview = previewDeviceMigration(f.a); expect(preview.can_migrate).toBe(false); noContents(preview);
    expect(() => migrateDeviceSettings(f.a, { revision: preview.revision, confirm: true })).toThrow('未开始迁移');
    expect(fs.readFileSync(target, 'utf8')).toBe(body); expect(fs.existsSync(path.join(f.a.deviceHome, 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(f.a.home, 'device-migration'))).toBe(false);
  }
});

for (const mutation of ['content', 'identity', 'aba', 'new-role', 'destination']) {
  test(`Markdown confirmation rejects late ${mutation} changes`, () => {
    const f = fixture(), source = write(f.a.home, 'agent/common.md', 'PRIVATE-MARKDOWN original');
    fs.utimesSync(source, 0, 0); const preview = previewDeviceMigration(f.a);
    if (mutation === 'content') fs.writeFileSync(source, 'PRIVATE-MARKDOWN changed');
    if (mutation === 'identity') { fs.renameSync(source, source + '-old'); write(f.a.home, 'agent/common.md', 'PRIVATE-MARKDOWN original'); fs.utimesSync(source, 0, 0); }
    if (mutation === 'aba') { fs.writeFileSync(source, 'PRIVATE-MARKDOWN changed!'); fs.writeFileSync(source, 'PRIVATE-MARKDOWN original'); fs.utimesSync(source, 0, 0); }
    if (mutation === 'new-role') write(f.a.home, 'agent/worker.md', 'PRIVATE-MARKDOWN new');
    if (mutation === 'destination') write(f.a.deviceHome, 'agent/common.md', 'PRIVATE-MARKDOWN target');
    expect(() => migrateDeviceSettings(f.a, { revision: preview.revision, confirm: true })).toThrow('过期');
    expect(fs.existsSync(path.join(f.a.home, 'device-migration'))).toBe(false); noContents(previewDeviceMigration(f.a));
  });
}

for (const side of ['source', 'destination']) for (const problem of ['mode', 'directory', 'symlink', 'hardlink', 'oversize', 'utf8', 'foreign-file']) {
  test(`Markdown migration rejects unsafe ${side} ${problem} without repairs or contents in errors`, () => {
    const f = fixture(); write(f.a.home, 'agent/common.md', 'PRIVATE-MARKDOWN');
    const home = side === 'source' ? f.a.home : f.a.deviceHome, file = write(home, 'agent/common.md', 'PRIVATE-MARKDOWN');
    if (problem === 'mode') fs.chmodSync(file, 0o644);
    if (problem === 'directory') fs.chmodSync(path.dirname(file), 0o755);
    if (problem === 'symlink') { fs.renameSync(file, file + '-real'); fs.symlinkSync(file + '-real', file); }
    if (problem === 'hardlink') fs.linkSync(file, file + '-alias');
    if (problem === 'oversize') fs.writeFileSync(file, 'PRIVATE-MARKDOWN'.repeat(5000));
    if (problem === 'utf8') fs.writeFileSync(file, Buffer.from([0xff]));
    const original = fs.lstatSync;
    if (problem === 'foreign-file') fs.lstatSync = function (name, ...args) {
      const stat = original.call(this, name, ...args);
      return name === file ? new Proxy(stat, { get(target, key) { return key === 'uid' ? process.getuid() + 1 : Reflect.get(target, key); } }) : stat;
    };
    try {
      const preview = previewDeviceMigration(f.a); expect(preview.can_migrate).toBe(false); noContents(preview);
      let message; try { migrateDeviceSettings(f.a, { revision: preview.revision, confirm: true }); } catch (error) { message = error.message; }
      expect(message).toBeString(); noContents(message); expect(fs.existsSync(path.join(f.a.home, 'device-migration'))).toBe(false);
    } finally { fs.lstatSync = original; }
  });
}

for (const phase of ['publish-before', 'publish-after', 'complete-before']) {
  test(`interrupted Markdown ${phase} preserves originals and resumes only after fresh explicit preview`, () => {
    const f = fixture(), body = 'PRIVATE-MARKDOWN original'; write(f.a.home, 'agent/common.md', body);
    const destination = path.join(f.a.deviceHome, 'agent/common.md'), old = previewDeviceMigration(f.a);
    const injection = inject('renameSync', (source, target) => phase.startsWith('publish') ? target === destination
      : String(target).endsWith('journal.json') && json(source).status === 'complete', (original, ...args) => {
      if (phase === 'publish-after') original(...args);
      throw new Error('PRIVATE-MARKDOWN injected failure');
    });
    try { expect(() => apply(f.a, old)).toThrow('未完成'); expect(injection.fired()).toBe(true); }
    finally { injection.restore(); }
    expect(fs.readFileSync(path.join(f.a.home, 'agent/common.md'), 'utf8')).toBe(body);
    expect(json(journal(f.a).file).status).not.toBe('complete');
    const preview = previewDeviceMigration(f.a); expect(preview.can_migrate).toBe(true); noContents(preview);
    expect(() => migrateDeviceSettings(f.a, { revision: old.revision, confirm: true })).toThrow('过期');
    expect(apply(f.a, preview).migrated).toBe(true);
    expect(fs.readFileSync(destination, 'utf8')).toBe(body); expect(fs.readFileSync(path.join(f.a.home, 'agent/common.md'), 'utf8')).toBe(body);
    expect(apply(f.a).already_migrated).toBe(true);
  });
}

for (const mutation of ['source', 'missing-source', 'backup', 'new-role', 'destination']) {
  test(`interrupted Markdown migration refuses changed ${mutation} facts`, () => {
    const f = fixture(); write(f.a.home, 'agent/common.md', 'PRIVATE-MARKDOWN original');
    const injection = inject('renameSync', (_source, destination) => destination === path.join(f.a.deviceHome, 'agent/common.md'), () => { throw new Error('failure'); });
    try { expect(() => apply(f.a)).toThrow('未完成'); } finally { injection.restore(); }
    if (mutation === 'source') write(f.a.home, 'agent/common.md', 'PRIVATE-MARKDOWN changed');
    if (mutation === 'missing-source') fs.unlinkSync(path.join(f.a.home, 'agent/common.md'));
    if (mutation === 'backup') write(path.join(f.a.home, 'device-migration', journal(f.a).id, 'files'), 'agent/common.md', 'PRIVATE-MARKDOWN changed');
    if (mutation === 'new-role') write(f.a.home, 'agent/worker.md', 'PRIVATE-MARKDOWN new');
    if (mutation === 'destination') write(f.a.deviceHome, 'agent/common.md', 'PRIVATE-MARKDOWN changed');
    const preview = previewDeviceMigration(f.a); expect(preview.can_migrate).toBe(false); noContents(preview);
  });
}

for (const mutation of ['source', 'destination', 'directory']) {
  test(`Markdown publication rejects a late ${mutation} change at the final write boundary`, () => {
    const f = fixture(); write(f.a.home, 'agent/common.md', 'PRIVATE-MARKDOWN original');
    const destination = path.join(f.a.deviceHome, 'agent/common.md');
    // Observe the destination temporary fd, not the earlier private backup writes.
    const open = fs.openSync; let destinationFd;
    fs.openSync = function (name, ...args) {
      const fd = open.call(this, name, ...args);
      if (typeof name === 'string' && name.startsWith(path.join(f.a.deviceHome, 'agent', '.migration-'))) destinationFd = fd;
      return fd;
    };
    const injection = inject('writeFileSync', file => typeof file === 'number' && file === destinationFd, (original, ...args) => {
      const result = original(...args);
      if (mutation === 'source') write(f.a.home, 'agent/common.md', 'PRIVATE-MARKDOWN changed');
      if (mutation === 'destination') write(f.a.deviceHome, 'agent/common.md', 'PRIVATE-MARKDOWN changed');
      if (mutation === 'directory') { fs.renameSync(path.dirname(destination), path.dirname(destination) + '-old'); fs.mkdirSync(path.dirname(destination), { mode: 0o700 }); }
      return result;
    });
    try { expect(() => apply(f.a)).toThrow('未完成'); expect(injection.fired()).toBe(true); }
    finally { injection.restore(); fs.openSync = open; }
    if (mutation === 'destination') expect(fs.readFileSync(destination, 'utf8')).toBe('PRIVATE-MARKDOWN changed');
    else expect(fs.existsSync(destination)).toBe(false);
    expect(fs.existsSync(path.join(f.a.home, 'agent/common.md'))).toBe(true);
  });
}

test('prior retained Markdown does not block explicit recovery of a later ordinary migration or resurrect deleted targets', () => {
  const f = fixture(); write(f.a.home, 'agent/common.md', 'PRIVATE-MARKDOWN original');
  const first = apply(f.a); fs.unlinkSync(path.join(f.a.deviceHome, 'agent/common.md'));
  write(f.a.home, 'settings.json', '{"version":1,"concurrency":3}');
  const injection = inject('renameSync', (_source, destination) => destination === path.join(f.a.deviceHome, 'settings.json'), () => { throw new Error('failure'); });
  try { expect(() => apply(f.a)).toThrow('未完成'); } finally { injection.restore(); }
  expect(json(journal(f.a).file).entries.map(row => row.key)).toEqual(['runtime']);
  expect(previewDeviceMigration(f.a).can_migrate).toBe(true); expect(apply(f.a).migrated).toBe(true);
  expect(fs.existsSync(path.join(f.a.deviceHome, 'agent/common.md'))).toBe(false);
  expect(fs.readFileSync(path.join(first.backup, 'agent/common.md'), 'utf8')).toBe('PRIVATE-MARKDOWN original');
  expect(apply(f.a).already_migrated).toBe(true);
});

for (const mutation of ['target-identity', 'backup-identity', 'backup-root']) {
  test(`final Markdown delivery rejects late ${mutation} changes even with identical contents`, () => {
    const f = fixture(); write(f.a.home, 'agent/common.md', 'PRIVATE-MARKDOWN original');
    const target = path.join(f.a.deviceHome, 'agent/common.md');
    const injection = inject('renameSync', (source, destination) => mutation === 'target-identity'
      ? String(destination).endsWith('journal.json') && json(source).entries.some(row => row.key === 'prompt-common' && row.phase === 'published')
      : destination === target, (original, ...args) => {
      const result = original(...args);
      const file = mutation === 'target-identity' ? target : path.join(f.a.home, 'device-migration', journal(f.a).id, 'files/agent/common.md');
      if (mutation === 'backup-root') {
        const root = path.dirname(path.dirname(file)); fs.renameSync(root, root + '-old'); fs.mkdirSync(root, { mode: 0o700 });
        fs.renameSync(path.join(root + '-old', 'agent'), path.join(root, 'agent'));
      } else {
        const body = fs.readFileSync(file); fs.renameSync(file, file + '-old'); fs.writeFileSync(file, body, { mode: 0o600 });
      }
      return result;
    });
    try { expect(() => apply(f.a)).toThrow('未完成'); expect(injection.fired()).toBe(true); }
    finally { injection.restore(); }
    expect(json(journal(f.a).file).status).not.toBe('complete');
    expect(fs.readFileSync(path.join(f.a.home, 'agent/common.md'), 'utf8')).toBe('PRIVATE-MARKDOWN original');
    expect(apply(f.a).migrated).toBe(true); expect(apply(f.a).already_migrated).toBe(true);
  });
}

test('changed retained originals require a new explicit migration and a new backup, never automatic propagation', () => {
  const f = fixture(); write(f.a.home, 'agent/common.md', 'PRIVATE-MARKDOWN original'); const first = apply(f.a);
  write(f.a.home, 'agent/common.md', 'PRIVATE-MARKDOWN changed');
  expect(agentPrompt(f.a, 'worker').text).toContain('PRIVATE-MARKDOWN original');
  expect(previewDeviceMigration(f.a).can_migrate).toBe(false);
  fs.unlinkSync(path.join(f.a.deviceHome, 'agent/common.md'));
  const second = apply(f.a); expect(second.backup).not.toBe(first.backup);
  expect(fs.readFileSync(path.join(first.backup, 'agent/common.md'), 'utf8')).toBe('PRIVATE-MARKDOWN original');
  expect(fs.readFileSync(path.join(second.backup, 'agent/common.md'), 'utf8')).toBe('PRIVATE-MARKDOWN changed');
  expect(agentPrompt(f.b, 'worker').text).toContain('PRIVATE-MARKDOWN changed');
  expect(json(journal(f.a).file).retained[0].id).toBe(journal(f.a).id);
});

test('retained Markdown provenance cannot select arbitrary keys, paths or backup locations', () => {
  for (const row of [{ key: 'runtime', id: '11111111-1111-4111-8111-111111111111' }, { key: 'prompt-common', id: '../../PRIVATE-MARKDOWN' }]) {
    const f = fixture(); write(f.a.home, 'agent/common.md', 'PRIVATE-MARKDOWN'); apply(f.a);
    const file = journal(f.a).file, value = json(file); value.retained = [row]; fs.writeFileSync(file, JSON.stringify(value));
    const preview = previewDeviceMigration(f.a); expect(preview.can_migrate).toBe(false); noContents(preview);
  }
});
