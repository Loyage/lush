import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, env } from './helpers.js';
import { readProjectAppearance, saveProjectAppearance, validateAppearanceUpdate } from '../src/host/project-appearance.js';
import { createProjectHost } from '../src/host/project-host.js';
import { projectRouteId, writeLauncherState } from '../src/host/registry.js';
import { acquireConfigurationLock } from '../src/core/device-config.js';
import { PROJECT_COLORS } from '../src/ui/web/assets/project-colors.js';

function setup(count = 1) {
  const root = temp(), global = path.join(root, 'global'); fs.mkdirSync(global, { mode: 0o700 });
  const projects = Array.from({ length: count }, (_, i) => {
    const project = path.join(root, `project-${i}`); fs.mkdirSync(project); return project;
  });
  const environment = env({ LUSH_GLOBAL_CONFIG: global });
  const options = { projects, env: environment };
  return { root, global, projects, environment, options,
    init(project = projects[0]) { return saveProjectAppearance(project, { initialize: true }, options); },
    close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
const file = project => path.join(project, '.lush', 'appearance.json');
const update = (value, patch = {}) => ({ color: value.color, expected_revision: value.revision, ...patch });

function child(f, project, body, allowConflict = false) {
  const module = new URL('../src/host/project-appearance.js', import.meta.url).href;
  const code = `import {saveProjectAppearance} from ${JSON.stringify(module)};
    for (let i=0;;i++) { try {
      console.log(JSON.stringify(saveProjectAppearance(${JSON.stringify(project)}, ${JSON.stringify(body)}, ${JSON.stringify(f.options)}))); break;
    } catch(error) { if (!error.message.includes('busy') || i===200) throw error; await Bun.sleep(5); } }`;
  const proc = Bun.spawn([process.execPath, '-e', code], { env: f.environment, stdout: 'pipe', stderr: 'pipe' });
  return (async () => {
    const [out, error, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (allowConflict && exit !== 0) {
      expect(error).toContain('revision conflict'); return { conflict: true };
    }
    expect(error).toBe(''); expect(exit).toBe(0); return JSON.parse(out);
  })();
}

test('appearance reads and Host lists never create .lush or start/attach a daemon', async () => {
  const f = setup(2), calls = [];
  try {
    for (const project of f.projects) writeLauncherState(project, f.environment);
    const host = createProjectHost(null, { env: f.environment,
      openProject: async () => { calls.push('start'); throw new Error('unexpected'); },
      attachProject: async () => { calls.push('attach'); throw new Error('unexpected'); } });
    expect(await host.status()).toMatchObject({ projects: f.projects.map(project => ({ id: projectRouteId(project) })) });
    await host.projects();
    for (const project of f.projects) {
      expect(readProjectAppearance(project)).toBeNull();
      expect(host.appearance(projectRouteId(project))).toEqual({ id: projectRouteId(project), name: path.basename(project), project, appearance: null });
      expect(fs.existsSync(path.join(project, '.lush'))).toBe(false);
    }
    expect(() => host.saveAppearance(projectRouteId(f.projects[0]))).toThrow('body must be an object');
    const first = host.saveAppearance(projectRouteId(f.projects[0]), { initialize: true });
    const second = createProjectHost(null, { env: f.environment });
    expect(second.appearance(first.id)).toEqual(first);
    expect(calls).toEqual([]);
    host.remove(first.id);
    expect(() => host.appearance(first.id)).toThrow('身份');
    expect(readProjectAppearance(first.project)).toEqual(first.appearance);
  } finally { f.close(); }
});

test('first open chooses unused presets, exhaustion chooses least used, initialize preserves edits', () => {
  const f = setup(9);
  try {
    const first = f.projects.map(project => f.init(project));
    expect(first.map(value => value.color)).toEqual(['green', 'blue', 'teal', 'amber', 'rose', 'slate', 'green', 'blue', 'teal']);
    expect(first.every(value => value.theme === 'system')).toBe(true);
    expect(first[0].revision).toMatch(/^[a-f0-9]{32}$/);
    const saved = saveProjectAppearance(f.projects[0], update(first[0], { color: 'rose' }), f.options);
    expect(saved.revision).not.toBe(first[0].revision);
    expect(f.init()).toEqual(saved);
    expect(readProjectAppearance(f.projects[0])).toEqual(saved);
    expect(fs.statSync(file(f.projects[0])).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file(f.projects[0]))).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(file(f.projects[0])))).toEqual(['appearance.json']);
    expect(PROJECT_COLORS.map(entry => entry.id)).toEqual(['green', 'blue', 'teal', 'amber', 'rose', 'slate']);
    expect(PROJECT_COLORS.every(entry => Object.keys(entry).sort().join() === 'id,label')).toBe(true);
  } finally { f.close(); }
});

test('allocation scans only caller registered/allowed set and does not initialize peers', () => {
  const f = setup(3);
  try {
    f.init(f.projects[0]);
    const result = saveProjectAppearance(f.projects[1], { initialize: true }, { ...f.options, projects: [f.projects[1], f.projects[2]] });
    expect(result.color).toBe('green');
    expect(fs.existsSync(path.join(f.projects[2], '.lush'))).toBe(false);
    const host = createProjectHost(null, { env: f.environment, allowedProjects: [f.projects[1]] });
    expect(() => host.appearance(projectRouteId(f.projects[0]))).toThrow('身份');
    for (const id of [f.projects[1], '../project', '0'.repeat(16), undefined]) expect(() => host.saveAppearance(id, { initialize: true })).toThrow('身份');
    const missing = path.join(f.root, 'gone');
    const next = saveProjectAppearance(f.projects[2], { initialize: true }, { ...f.options, projects: [missing] });
    expect(next.color).toBe('green');
    expect(fs.existsSync(missing)).toBe(false);
  } finally { f.close(); }
});

test('full save requires exact schema and a current revision, never creates on conflict', () => {
  const f = setup();
  try {
    expect(() => saveProjectAppearance(f.projects[0], { theme: 'light', color: 'blue', expected_revision: 'a'.repeat(32) }, f.options)).toThrow('revision conflict');
    expect(fs.existsSync(file(f.projects[0]))).toBe(false);
    expect(fs.existsSync(path.join(f.projects[0], '.lush'))).toBe(false);
    const value = f.init(), original = fs.readFileSync(file(f.projects[0]), 'utf8');
    for (const body of [null, [], {}, { initialize: false }, { initialize: true, theme: 'system' },
      { initialize: true, _token: '' }, update(value, { theme: 'invalid' }), update(value, { color: '#123456' }),
      update(value, { expected_revision: null }), update(value, { expected_revision: '' }),
      update(value, { project: f.projects[0] }), update(value, { _token: '' }), update(value, { version: 1 }),
      { theme: 'light', color: 'blue' }]) {
      expect(() => validateAppearanceUpdate(body)).toThrow();
      expect(() => saveProjectAppearance(f.projects[0], body, f.options)).toThrow();
      expect(fs.readFileSync(file(f.projects[0]), 'utf8')).toBe(original);
    }
    expect(() => saveProjectAppearance(f.projects[0], update(value, { theme: 'light' }), f.options)).toThrow('themes are inactive');
    expect(fs.readFileSync(file(f.projects[0]), 'utf8')).toBe(original);
    const changed = saveProjectAppearance(f.projects[0], update(value, { color: 'rose' }), f.options);
    expect(changed.theme).toBe(value.theme);
    expect(() => saveProjectAppearance(f.projects[0], update(value, { color: 'blue' }), f.options)).toThrow('revision conflict');
    expect(readProjectAppearance(f.projects[0])).toEqual(changed);
  } finally { f.close(); }
});

test('invalid, oversized, nonprivate, nonregular, aliased and hardlinked files are never overwritten', () => {
  const f = setup(), project = f.projects[0];
  try {
    const valid = f.init(), home = path.dirname(file(project)), original = JSON.stringify(valid);
    const bad = ['PRIVATE-RAW-NOT-JSON', 'x'.repeat(4097), JSON.stringify({ ...valid, version: 2 }),
      JSON.stringify({ ...valid, color: 'purple' }), JSON.stringify({ ...valid, extra: 'PRIVATE-RAW' }), JSON.stringify({ ...valid, revision: 42 })];
    for (const value of bad) {
      fs.writeFileSync(file(project), value);
      expect(() => readProjectAppearance(project)).toThrow();
      expect(() => f.init()).toThrow();
      try { f.init(); throw new Error('unexpected success'); } catch (error) { expect(error.message).not.toContain('PRIVATE-RAW'); }
      expect(fs.readFileSync(file(project), 'utf8')).toBe(value);
    }
    fs.writeFileSync(file(project), original); fs.chmodSync(file(project), 0o644);
    expect(() => f.init()).toThrow('unsafe'); expect(fs.statSync(file(project)).mode & 0o777).toBe(0o644);
    fs.chmodSync(file(project), 0o600);
    fs.linkSync(file(project), path.join(f.root, 'linked'));
    expect(() => readProjectAppearance(project)).toThrow('unsafe'); fs.unlinkSync(path.join(f.root, 'linked'));
    fs.unlinkSync(file(project)); fs.symlinkSync(path.join(f.root, 'absent'), file(project));
    expect(() => f.init()).toThrow('unsafe'); expect(fs.lstatSync(file(project)).isSymbolicLink()).toBe(true);
    fs.unlinkSync(file(project)); fs.mkdirSync(file(project)); expect(() => f.init()).toThrow('unsafe'); fs.rmdirSync(file(project));
    fs.writeFileSync(file(project), original, { mode: 0o600 });
    fs.chmodSync(home, 0o755); expect(() => f.init()).toThrow('unsafe'); expect(fs.statSync(home).mode & 0o777).toBe(0o755);
    fs.chmodSync(home, 0o700);
    fs.renameSync(home, path.join(f.root, 'moved')); fs.symlinkSync(path.join(f.root, 'moved'), home);
    expect(() => f.init()).toThrow('unsafe');
    fs.unlinkSync(home); fs.renameSync(path.join(f.root, 'moved'), home);
    const alias = path.join(f.root, 'alias'); fs.symlinkSync(project, alias);
    expect(() => readProjectAppearance(alias)).toThrow('unsafe');
    const host = createProjectHost(null, { env: f.environment, allowedProjects: [alias] });
    expect(() => host.appearance(projectRouteId(project))).toThrow('身份');
    expect(() => host.appearance(projectRouteId(alias))).toThrow('unsafe');
  } finally { f.close(); }
});

test('foreign owners are rejected at project, private root and file boundaries', () => {
  const f = setup(), project = f.projects[0]; f.init();
  const original = fs.lstatSync;
  try {
    for (const target of [project, path.dirname(file(project)), file(project)]) {
      fs.lstatSync = (...args) => {
        const stat = original(...args);
        if (args[0] === target) stat.uid = process.getuid() + 1;
        return stat;
      };
      expect(() => readProjectAppearance(project)).toThrow('unsafe');
      expect(() => f.init()).toThrow('unsafe');
    }
  } finally { fs.lstatSync = original; f.close(); }
});

test('read refuses file replacement/growth between lstat, open and bounded read', () => {
  const f = setup(), project = f.projects[0], originalOpen = fs.openSync, originalRead = fs.readSync;
  try {
    const value = f.init(), target = file(project), outsider = path.join(f.root, 'outsider');
    fs.writeFileSync(outsider, JSON.stringify(value), { mode: 0o600 });
    fs.openSync = (...args) => {
      if (args[0] === target) { fs.unlinkSync(target); fs.symlinkSync(outsider, target); }
      return originalOpen(...args);
    };
    expect(() => readProjectAppearance(project)).toThrow();
    fs.openSync = originalOpen;
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    fs.unlinkSync(target); fs.writeFileSync(target, JSON.stringify(value), { mode: 0o600 });
    fs.readSync = (...args) => { fs.appendFileSync(target, 'x'.repeat(4097)); return originalRead(...args); };
    expect(() => readProjectAppearance(project)).toThrow('changed');
    expect(fs.statSync(target).size).toBeGreaterThan(4096);
  } finally { fs.openSync = originalOpen; fs.readSync = originalRead; f.close(); }
});

test('write rechecks revision and locked root immediately before atomic publication', () => {
  const f = setup(), project = f.projects[0], originalSync = fs.fsyncSync;
  try {
    const value = f.init(), external = { ...value, theme: 'light', revision: 'f'.repeat(32) };
    let replaced = false;
    fs.fsyncSync = fd => {
      originalSync(fd);
      if (!replaced) { replaced = true; fs.writeFileSync(file(project), JSON.stringify(external)); }
    };
    expect(() => saveProjectAppearance(project, update(value, { color: 'rose' }), f.options)).toThrow('changed');
    fs.fsyncSync = originalSync;
    expect(readProjectAppearance(project)).toEqual(external);
    expect(fs.readdirSync(path.dirname(file(project)))).toEqual(['appearance.json']);
    replaced = false;
    const moved = path.join(f.root, 'moved-private-root'), home = path.dirname(file(project));
    fs.fsyncSync = fd => {
      originalSync(fd);
      if (!replaced) { replaced = true; fs.renameSync(home, moved); fs.mkdirSync(home, { mode: 0o700 }); }
    };
    expect(() => saveProjectAppearance(project, update(external, { color: 'blue' }), f.options)).toThrow('lock changed');
    fs.fsyncSync = originalSync;
    expect(fs.readdirSync(home)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(moved, 'appearance.json'), 'utf8'))).toEqual(external);
    expect(fs.existsSync(path.join(moved, '.settings-write.lock'))).toBe(true);
  } finally { fs.fsyncSync = originalSync; f.close(); }
});

test('global and project cross-process locks fail closed; unknown locks and unsafe roots are preserved', () => {
  const f = setup(), project = f.projects[0];
  try {
    const globalLock = acquireConfigurationLock({ home: f.global });
    try { expect(() => f.init()).toThrow('busy'); expect(fs.existsSync(file(project))).toBe(false); }
    finally { globalLock.release(); }
    const value = f.init();
    const lock = acquireConfigurationLock({ home: path.dirname(file(project)) });
    try {
      const other = { ...f.options, env: env({ LUSH_GLOBAL_CONFIG: path.join(f.root, 'other-host') }) };
      expect(() => saveProjectAppearance(project, update(value), other)).toThrow('busy');
      expect(readProjectAppearance(project)).toEqual(value);
    } finally { lock.release(); }
    fs.mkdirSync(path.join(f.global, '.settings-write.lock'), { mode: 0o700 });
    expect(() => saveProjectAppearance(project, update(value), f.options)).toThrow('busy');
    expect(fs.existsSync(path.join(f.global, '.settings-write.lock'))).toBe(true);
    fs.rmdirSync(path.join(f.global, '.settings-write.lock'));
    fs.chmodSync(f.global, 0o755);
    expect(() => saveProjectAppearance(project, update(value), f.options)).toThrow('unsafe');
    expect(fs.statSync(f.global).mode & 0o777).toBe(0o755);
  } finally { f.close(); }
});

test('multiple Host processes allocate unused colors serially and initialize one project idempotently', async () => {
  const f = setup(7);
  try {
    const results = await Promise.all(f.projects.slice(0, 6).map(project => child(f, project, { initialize: true })));
    expect(new Set(results.map(value => value.color)).size).toBe(6);
    const sameProject = await Promise.all(Array.from({ length: 5 }, () => child(f, f.projects[6], { initialize: true })));
    expect(sameProject.every(value => value.revision === sameProject[0].revision)).toBe(true);
    expect(sameProject[0].color).toBe('green');
    expect(readProjectAppearance(f.projects[6])).toEqual(sameProject[0]);
  } finally { f.close(); }
}, 15000);

test('cross-process saves with one revision have exactly one winner, also across different Host roots', async () => {
  const f = setup(), project = f.projects[0];
  try {
    const value = f.init();
    const otherGlobal = path.join(f.root, 'other-host'); fs.mkdirSync(otherGlobal, { mode: 0o700 });
    const other = { ...f, options: { ...f.options, env: env({ LUSH_GLOBAL_CONFIG: otherGlobal }) } };
    const results = await Promise.all([
      child(f, project, update(value, { color: 'blue' }), true),
      child(other, project, update(value, { color: 'rose' }), true),
    ]);
    expect(results.filter(value => value.conflict).length).toBe(1);
    const winner = results.find(value => !value.conflict);
    expect(readProjectAppearance(project)).toEqual(winner);
    expect(winner.revision).not.toBe(value.revision);
  } finally { f.close(); }
}, 15000);

test('atomic rename failure keeps the original appearance and removes owned temp/locks', () => {
  const f = setup(), project = f.projects[0], originalRename = fs.renameSync;
  try {
    const value = f.init();
    fs.renameSync = () => { throw new Error('injected rename failure'); };
    expect(() => saveProjectAppearance(project, update(value, { color: 'rose' }), f.options)).toThrow('injected');
    expect(readProjectAppearance(project)).toEqual(value);
    expect(fs.readdirSync(path.dirname(file(project)))).toEqual(['appearance.json']);
    expect(fs.readdirSync(f.global)).toEqual([]);
  } finally { fs.renameSync = originalRename; f.close(); }
});
