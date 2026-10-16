import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { RunnerSettings, normalizeRunnerNode } from '../src/core/runner-settings.js';
import { acquireConfigurationLock } from '../src/core/device-config.js';
import { temp } from './helpers.js';

const node = () => ({ name: 'Build Linux', ssh_alias: 'build-linux', enabled: true,
  budgets: { max_commands: 2, timeout_ms: 20000, output_bytes: 65536 } });
function fixture() {
  const root = temp(), config = { project: path.join(root, 'project'), home: path.join(root, 'project', '.lush'), deviceHome: path.join(root, 'device') };
  const settings = new RunnerSettings(config);
  return { root, config, settings, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('Runner configuration is private, shared by device, absent-read-only and revision guarded', () => {
  const f = fixture(); try {
    const before = f.settings.read(); expect(before.nodes).toEqual([]);
    expect(fs.existsSync(f.config.deviceHome)).toBe(false);
    const saved = f.settings.save({ nodes: [node()] }, before.revision);
    expect(saved.nodes[0].id).toMatch(/^[a-f0-9-]{36}$/);
    expect(saved.revision).not.toBe(before.revision);
    const other = new RunnerSettings({ ...f.config, project: path.join(f.root, 'other'), home: path.join(f.root, 'other', '.lush') });
    expect(other.read()).toEqual(saved); expect(fs.existsSync(f.config.home)).toBe(false);
    expect(fs.statSync(f.config.deviceHome).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(f.config.deviceHome, 'runners.json')).mode & 0o777).toBe(0o600);
    expect(() => other.save({ nodes: [] }, before.revision)).toThrow('revision changed');
    const off = other.save({ nodes: [{ ...saved.nodes[0], enabled: false }] }, saved.revision);
    const on = other.save({ nodes: saved.nodes }, off.revision);
    expect(on.revision).not.toBe(saved.revision); // Disable/re-enable cannot create an ABA revision.
    expect(() => other.save({ nodes: [] }, saved.revision)).toThrow('revision changed');
    saved.nodes[0].name = 'mutated'; expect(other.read().nodes[0].name).toBe('Build Linux');
    expect(new RunnerSettings({ home: f.config.deviceHome }).read()).toEqual(on); // Explicit Host root.
    expect(() => new RunnerSettings({ project: f.config.project, home: f.config.home })).toThrow('device');
  } finally { f.close(); }
});

test('node identities are allocated centrally, aliases stay fixed and retired IDs cannot be reused', () => {
  const f = fixture(); try {
    const first = f.settings.save({ nodes: [node()] }, f.settings.read().revision);
    const original = first.nodes[0];
    expect(() => f.settings.save({ nodes: [{ ...original, ssh_alias: 'other-node' }] }, first.revision)).toThrow('fixed');
    expect(() => f.settings.save({ nodes: [original, original] }, first.revision)).toThrow('duplicate');
    const gone = f.settings.save({ nodes: [] }, first.revision);
    expect(() => f.settings.save({ nodes: [original] }, gone.revision)).toThrow('retired');
    const fresh = f.settings.save({ nodes: [node()] }, gone.revision);
    expect(fresh.nodes[0].id).not.toBe(original.id);
    expect(JSON.parse(fs.readFileSync(path.join(f.config.deviceHome, 'runners.json'), 'utf8')).retired_ids).toEqual([original.id]);
    expect(() => f.settings.save({ nodes: [{ ...node(), id: '12345678-1234-1234-1234-123456789abc' }] }, fresh.revision)).toThrow('unknown');
  } finally { f.close(); }
});

test('installation identity starts unpinned and can only be fixed, never silently swapped or cleared', () => {
  const f = fixture(); try {
    const initial = f.settings.save({ nodes: [node()] }, f.settings.read().revision);
    expect(initial.nodes[0].expected_runner_id).toBeNull();
    const pinned = f.settings.save({ nodes: [{ ...initial.nodes[0], expected_runner_id: 'runner-installation-one' }] }, initial.revision);
    expect(pinned.nodes[0].expected_runner_id).toBe('runner-installation-one');
    expect(() => f.settings.save({ nodes: [{ ...pinned.nodes[0], expected_runner_id: 'runner-installation-two' }] }, pinned.revision)).toThrow('pinned');
    expect(() => f.settings.save({ nodes: [{ ...pinned.nodes[0], expected_runner_id: null }] }, pinned.revision)).toThrow('pinned');
    expect(() => f.settings.save({ nodes: initial.nodes }, initial.revision)).toThrow('revision');
    for (const expected_runner_id of ['', '/remote/path', 'runner;cmd', 1])
      expect(() => normalizeRunnerNode({ ...node(), expected_runner_id })).toThrow('installation');
    expect(new RunnerSettings(f.config).read()).toEqual(pinned);
    const file = path.join(f.config.deviceHome, 'runners.json'), legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete legacy.nodes[0].expected_runner_id;
    fs.writeFileSync(file, JSON.stringify(legacy)); // Simulate the pre-pin auxiliary format, not an automatic migration.
    expect(f.settings.read().nodes[0].expected_runner_id).toBeNull();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).nodes[0]).not.toHaveProperty('expected_runner_id');
  } finally { f.close(); }
});

test('SSH aliases, fields and budgets reject option/command injection without echoing sensitive values', () => {
  const f = fixture(); try {
    const revision = f.settings.read().revision;
    for (const ssh_alias of ['-oProxyCommand=evil', 'host;touch pwn', 'host\nsh', 'user@host', 'ssh://host', '/tmp/host', '$(evil)', '`evil`', 'host space', 'a\\b', 'a'.repeat(129)]) {
      expect(() => normalizeRunnerNode({ ...node(), ssh_alias })).toThrow('SSH alias');
    }
    for (const value of [{ ...node(), id: 'local' }, { ...node(), command: 'PRIVATE-SECRET' }, { ...node(), key: 'PRIVATE-SECRET' },
      { ...node(), enabled: 1 }, { ...node(), name: 'bad\nname' }, { ...node(), budgets: {} },
      ...['max_commands', 'timeout_ms', 'output_bytes'].flatMap(key => [0, -1, 1.2, Number.MAX_SAFE_INTEGER].map(value =>
        ({ ...node(), budgets: { ...node().budgets, [key]: value } })))]) {
      expect(() => f.settings.save({ nodes: [value] }, revision)).toThrow();
      try { f.settings.save({ nodes: [value] }, revision); } catch (error) { expect(error.message).not.toContain('PRIVATE-SECRET'); }
    }
    expect(fs.existsSync(f.config.deviceHome)).toBe(false);
    for (const ssh_alias of ['node-1', 'alias.name', 'node_2']) expect(normalizeRunnerNode({ ...node(), ssh_alias }).ssh_alias).toBe(ssh_alias);
  } finally { f.close(); }
});

test('Runner settings share the configuration lock and never steal unknown locks', () => {
  const f = fixture(); try {
    const initial = f.settings.read(), lock = acquireConfigurationLock(f.config, 'device');
    try { expect(() => f.settings.save({ nodes: [node()] }, initial.revision)).toThrow('busy'); }
    finally { lock.release(); }
    fs.mkdirSync(path.join(f.config.deviceHome, '.settings-write.lock'), { mode: 0o700 });
    expect(() => f.settings.save({ nodes: [node()] }, initial.revision)).toThrow('busy');
    expect(fs.existsSync(path.join(f.config.deviceHome, '.settings-write.lock'))).toBe(true);
    expect(f.settings.read()).toEqual(initial);
  } finally { f.close(); }
});

test('unsafe files, links, modes, malformed or over-budget content fail closed without touching the target', () => {
  for (const kind of ['root-mode', 'root-link', 'file-mode', 'file-link', 'hardlink', 'corrupt', 'oversized', 'unknown-field']) {
    const f = fixture(); try {
      const saved = f.settings.save({ nodes: [node()] }, f.settings.read().revision);
      const file = path.join(f.config.deviceHome, 'runners.json'), external = path.join(f.root, 'external');
      fs.writeFileSync(external, 'PRIVATE-SECRET', { mode: 0o600 });
      if (kind === 'root-mode') fs.chmodSync(f.config.deviceHome, 0o755);
      if (kind === 'root-link') { fs.renameSync(f.config.deviceHome, f.config.deviceHome + '-old'); fs.symlinkSync(f.config.deviceHome + '-old', f.config.deviceHome); }
      if (kind === 'file-mode') fs.chmodSync(file, 0o644);
      if (kind === 'file-link' || kind === 'hardlink') { fs.unlinkSync(file); kind === 'file-link' ? fs.symlinkSync(external, file) : fs.linkSync(external, file); }
      if (kind === 'corrupt') fs.writeFileSync(file, 'PRIVATE-SECRET');
      if (kind === 'oversized') fs.writeFileSync(file, 'x'.repeat(128 * 1024 + 1));
      if (kind === 'unknown-field') fs.writeFileSync(file, JSON.stringify({ version: 1, nodes: [], key: 'PRIVATE-SECRET' }));
      expect(() => f.settings.read()).toThrow();
      expect(() => f.settings.save({ nodes: [] }, saved.revision)).toThrow();
      try { f.settings.read(); } catch (error) { expect(error.message).not.toContain('PRIVATE-SECRET'); }
      expect(fs.readFileSync(external, 'utf8')).toBe('PRIVATE-SECRET');
    } finally { f.close(); }
  }
});

test('independent processes cannot both save the same Runner revision', async () => {
  const f = fixture(); try {
    const initial = f.settings.read(), module = path.resolve('src/core/runner-settings.js');
    const children = [1, 2].map(n => Bun.spawn([process.execPath, '--eval', `
      import {RunnerSettings} from ${JSON.stringify(module)};
      try { new RunnerSettings(${JSON.stringify(f.config)}).save({nodes:[${JSON.stringify({ ...node(), name: `node-${n}` })}]}, ${JSON.stringify(initial.revision)}); console.log('saved'); }
      catch { console.log('rejected'); }
    `], { stdout: 'pipe', stderr: 'pipe' }));
    const results = await Promise.all(children.map(async child => {
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { out: out.trim(), err, code };
    }));
    expect(results.map(row => row.out).sort()).toEqual(['rejected', 'saved']);
    expect(results.every(row => row.code === 0 && row.err === '')).toBe(true);
    expect(fs.readdirSync(f.config.deviceHome)).toEqual(['runners.json']);
  } finally { f.close(); }
});
