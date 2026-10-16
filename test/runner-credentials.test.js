import { test, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { RunnerCredentials, validateRunnerControlToken } from '../src/core/runner-credentials.js';
import { RunnerSettings } from '../src/core/runner-settings.js';
import { acquireConfigurationLock } from '../src/core/device-config.js';
import { temp } from './helpers.js';

const NODE = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
// Deliberately deterministic, non-production test material; encoding checks do not prove entropy.
const MACHINE = 'a1'.repeat(32), CONTROL = Buffer.alloc(32, 252).toString('base64url'), ROTATED = 'b2'.repeat(32);
function fixture() {
  const root = temp(), config = { project: path.join(root, 'project'), home: path.join(root, 'project', '.lush'), deviceHome: path.join(root, 'device') };
  const credentials = new RunnerCredentials(config), file = path.join(config.deviceHome, 'runner-credentials.json');
  return { root, config, file, credentials, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const save = f => f.credentials.save({ node_id: NODE, machine_token: MACHINE, project_id: 'project-one', control_token: CONTROL }, f.credentials.read().revision);
function safe(result) {
  const serialized = JSON.stringify(result);
  for (const value of [MACHINE, CONTROL, ROTATED, 'machine_token', 'control_token']) expect(serialized).not.toContain(value);
}

test('public credential reads and writes expose only configured metadata while snapshot returns the exact scoped pair', () => {
  const f = fixture(); try {
    const initial = f.credentials.read(); expect(initial).toEqual({ version: 1, revision: 'absent', nodes: [] });
    expect(fs.existsSync(f.config.deviceHome)).toBe(false);
    expect(() => f.credentials.snapshot(NODE, 'project-one')).toThrow('not configured');
    expect(fs.existsSync(f.config.deviceHome)).toBe(false);
    const saved = save(f); safe(saved); expect(saved.revision).toMatch(/^[a-f0-9-]{36}$/);
    expect(saved.nodes).toEqual([{ node_id: NODE, machine_configured: true, projects: [{ project_id: 'project-one', control_configured: true }] }]);
    expect(f.credentials.snapshot(NODE, 'project-one')).toEqual({ machine_token: MACHINE, control_token: CONTROL });
    const snapshot = f.credentials.snapshot(NODE, 'project-one'); snapshot.machine_token = ROTATED;
    expect(f.credentials.snapshot(NODE, 'project-one').machine_token).toBe(MACHINE);
    expect(fs.statSync(f.config.deviceHome).mode & 0o777).toBe(0o700);
    expect(fs.statSync(f.file).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(f.config.home)).toBe(false);
    expect(new RunnerSettings(f.config).read().nodes).toEqual([]); // Secrets never enter node metadata.
    expect(new RunnerCredentials({ ...f.config, home: path.join(f.root, 'other-project') }).read()).toEqual(saved);
    expect(new RunnerCredentials({ home: f.config.deviceHome }).read()).toEqual(saved);
    expect(() => new RunnerCredentials({ project: f.root, home: f.root })).toThrow('device');
    expect(() => f.credentials.snapshot(OTHER, 'project-one')).toThrow('not configured');
    expect(() => f.credentials.snapshot(NODE, 'project-two')).toThrow('not configured');
    safe(f.credentials.read()); expect(JSON.stringify(f.credentials)).toBe('{}');
  } finally { f.close(); }
});

test('credential CAS, reopen, rotation and exact deletion preserve other projects and node secrets', () => {
  const f = fixture(); try {
    const initial = f.credentials.read(), first = save(f);
    expect(() => f.credentials.save({ node_id: NODE, machine_token: ROTATED }, initial.revision)).toThrow('revision');
    let current = f.credentials.save({ node_id: NODE, project_id: 'project-two', control_token: ROTATED }, first.revision);
    current = f.credentials.save({ node_id: OTHER, machine_token: ROTATED, project_id: 'project-one', control_token: MACHINE }, current.revision);
    current = f.credentials.remove({ node_id: NODE, project_id: 'project-one' }, current.revision); safe(current);
    expect(() => f.credentials.snapshot(NODE, 'project-one')).toThrow('not configured');
    expect(f.credentials.snapshot(NODE, 'project-two')).toEqual({ machine_token: MACHINE, control_token: ROTATED });
    expect(f.credentials.snapshot(OTHER, 'project-one')).toEqual({ machine_token: ROTATED, control_token: MACHINE });
    expect(() => f.credentials.remove({ node_id: OTHER }, first.revision)).toThrow('revision');
    current = f.credentials.remove({ node_id: NODE }, current.revision);
    expect(new RunnerCredentials(f.config).read()).toEqual(current);
    expect(() => f.credentials.snapshot(NODE, 'project-two')).toThrow('not configured');
    expect(f.credentials.snapshot(OTHER, 'project-one').machine_token).toBe(ROTATED);
    current = f.credentials.remove({ node_id: OTHER }, current.revision);
    expect(current.nodes).toEqual([]); expect(current.revision).not.toBe('absent');
    const restored = save(f); expect(restored.revision).not.toBe(first.revision); // Delete/recreate is not ABA.
    expect(fs.readdirSync(f.config.deviceHome)).toEqual(['runner-credentials.json']);
    safe(restored);
  } finally { f.close(); }
});

test('partial configuration never grants a snapshot and project-only removal leaves no phantom entry', () => {
  const f = fixture(); try {
    let current = f.credentials.save({ node_id: NODE, project_id: 'project-one', control_token: CONTROL }, 'absent');
    expect(current.nodes[0].machine_configured).toBe(false);
    expect(() => f.credentials.snapshot(NODE, 'project-one')).toThrow('not configured');
    current = f.credentials.remove({ node_id: NODE, project_id: 'project-one' }, current.revision);
    expect(current.nodes).toEqual([]);
    current = f.credentials.save({ node_id: NODE, machine_token: MACHINE }, current.revision);
    expect(current.nodes[0].projects).toEqual([]);
    expect(() => f.credentials.snapshot(NODE, 'project-one')).toThrow('not configured');
  } finally { f.close(); }
});

test('token encoding and identity validation are bounded, reject paths and never echo bad input', () => {
  const f = fixture(); try {
    for (const valid of [MACHINE, CONTROL, '0'.repeat(64), Buffer.alloc(32).toString('base64url'), 'AB'.repeat(128)])
      expect(validateRunnerControlToken(valid)).toBe(valid);
    const badTokens = ['PRIVATE-SECRET', 'a'.repeat(32), 'a'.repeat(257), `${CONTROL}=`, ` ${MACHINE}`, `${MACHINE}\n`, '秘密'.repeat(32), null, {}, []];
    for (const value of badTokens) {
      expect(() => f.credentials.save({ node_id: NODE, machine_token: value }, 'absent')).toThrow();
      try { f.credentials.save({ node_id: NODE, machine_token: value }, 'absent'); }
      catch (error) { expect(error.message).not.toContain('PRIVATE-SECRET'); expect(error.message).not.toContain(MACHINE); }
    }
    for (const value of [{ node_id: '../PRIVATE-SECRET', machine_token: MACHINE }, { node_id: 'local', machine_token: MACHINE },
      { node_id: NODE, project_id: '/project/path', control_token: CONTROL }, { node_id: NODE, control_token: CONTROL },
      { node_id: NODE, project_id: 'project-one' }, { node_id: NODE }, { node_id: NODE, machine_token: MACHINE, env: {} }])
      expect(() => f.credentials.save(value, 'absent')).toThrow();
    expect(() => f.credentials.remove({ node_id: NODE, project_id: '../path' }, 'absent')).toThrow();
    expect(fs.existsSync(f.config.deviceHome)).toBe(false);
  } finally { f.close(); }
});

test('credential operations share the device lock, including explicit removal', () => {
  const f = fixture(); try {
    const current = save(f), lock = acquireConfigurationLock(f.config, 'device');
    try {
      expect(() => f.credentials.save({ node_id: NODE, machine_token: ROTATED }, current.revision)).toThrow('busy');
      expect(() => f.credentials.remove({ node_id: NODE }, current.revision)).toThrow('busy');
      expect(f.credentials.read()).toEqual(current);
    } finally { lock.release(); }
    expect(f.credentials.snapshot(NODE, 'project-one').machine_token).toBe(MACHINE);
  } finally { f.close(); }
});

test('credential files reject aliases, links, hardlinks, modes, directories and oversized/corrupt data without repair', () => {
  for (const kind of ['root-mode', 'root-link', 'file-mode', 'file-link', 'hardlink', 'directory', 'corrupt', 'oversized', 'schema']) {
    const f = fixture(); try {
      const current = save(f), external = path.join(f.root, 'external'); fs.writeFileSync(external, MACHINE, { mode: 0o600 });
      if (kind === 'root-mode') fs.chmodSync(f.config.deviceHome, 0o755);
      if (kind === 'root-link') { fs.renameSync(f.config.deviceHome, f.config.deviceHome + '-old'); fs.symlinkSync(f.config.deviceHome + '-old', f.config.deviceHome); }
      if (kind === 'file-mode') fs.chmodSync(f.file, 0o644);
      if (['file-link', 'hardlink', 'directory'].includes(kind)) {
        fs.unlinkSync(f.file);
        if (kind === 'file-link') fs.symlinkSync(external, f.file);
        else if (kind === 'hardlink') fs.linkSync(external, f.file);
        else fs.mkdirSync(f.file);
      }
      if (kind === 'corrupt') fs.writeFileSync(f.file, MACHINE);
      if (kind === 'oversized') fs.writeFileSync(f.file, 'x'.repeat(256 * 1024 + 1));
      if (kind === 'schema') fs.writeFileSync(f.file, JSON.stringify({ version: 1, revision: current.revision, nodes: [], secret: MACHINE }));
      for (const action of [() => f.credentials.read(), () => f.credentials.snapshot(NODE, 'project-one'),
        () => f.credentials.save({ node_id: NODE, machine_token: ROTATED }, current.revision), () => f.credentials.remove({ node_id: NODE }, current.revision)]) {
        expect(action).toThrow(); try { action(); } catch (error) { safe({ error: error.message }); }
      }
      expect(fs.readFileSync(external, 'utf8')).toBe(MACHINE);
    } finally { f.close(); }
  }
});

test('failed atomic publication removes only its temporary file and never leaks an injected secret-bearing IO error', () => {
  const f = fixture(); let spy;
  try {
    const current = save(f), original = fs.readFileSync(f.file, 'utf8');
    spy = spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error(`${MACHINE} ${CONTROL}`); });
    try { f.credentials.save({ node_id: NODE, machine_token: ROTATED }, current.revision); throw new Error('save unexpectedly succeeded'); }
    catch (error) { safe({ error: error.message }); expect(error.message).toContain('not confirmed'); }
    spy.mockRestore(); spy = null;
    expect(fs.readFileSync(f.file, 'utf8')).toBe(original);
    expect(fs.readdirSync(f.config.deviceHome)).toEqual(['runner-credentials.json']);
    expect(f.credentials.read()).toEqual(current);
  } finally { spy?.mockRestore(); f.close(); }
});

test('two processes cannot both publish control credentials against the same revision', async () => {
  const f = fixture(); try {
    const module = path.resolve('src/core/runner-credentials.js');
    const children = [MACHINE, ROTATED].map(machine_token => Bun.spawn([process.execPath, '--eval', `
      import {RunnerCredentials} from ${JSON.stringify(module)};
      try { new RunnerCredentials(${JSON.stringify(f.config)}).save(${JSON.stringify({ node_id: NODE, machine_token })}, 'absent'); console.log('saved'); }
      catch { console.log('rejected'); }
    `], { stdout: 'pipe', stderr: 'pipe' }));
    const results = await Promise.all(children.map(async child => {
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { out: out.trim(), err, code };
    }));
    expect(results.map(row => row.out).sort()).toEqual(['rejected', 'saved']);
    expect(results.every(row => row.code === 0 && row.err === '')).toBe(true); safe(results);
    expect(fs.readdirSync(f.config.deviceHome)).toEqual(['runner-credentials.json']); safe(f.credentials.read());
  } finally { f.close(); }
});
