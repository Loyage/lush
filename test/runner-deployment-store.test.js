import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeploymentStore } from '../src/core/runner-deployment-store.js';

const body = (status = 'planned', ssh_alias = 'fixture') => ({ status, ssh_alias, name: 'Fixture', project_id: 'paired-project', plan: { actions: [], supported: true }, stages: [], private_data: {} });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-test-deployment-store-')), home = path.join(root, 'device');
  return { root, home, config: { home }, store: new DeploymentStore({ home }), close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
test('deployment reads are inert; receipts use independent owner-private CAS and preserve fixed identity/plan', () => {
  const f = fixture();
  try {
    expect(f.store.list()).toEqual({ version: 1, items: [] }); expect(fs.existsSync(f.home)).toBe(false);
    const initial = f.store.create(body()); expect(initial.revision).toBe(1); expect(initial.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(fs.statSync(f.home).mode & 0o777).toBe(0o700); expect(fs.statSync(path.join(f.home, 'runner-deployments.json')).mode & 0o777).toBe(0o600);
    // A settings writer's separate lock cannot be held over a deployment network wait.
    fs.mkdirSync(path.join(f.home, '.settings-write.lock'), { mode: 0o700 });
    const changed = f.store.change(initial.id, 1, row => { row.status = 'running'; row.private_data.plan_sha256 = 'a'.repeat(64); });
    expect(changed.revision).toBe(2); expect(new DeploymentStore(f.config).read(initial.id)).toEqual(changed);
    expect(() => f.store.change(initial.id, 1, row => { row.status = 'ready'; })).toThrow('revision');
    expect(() => f.store.change(initial.id, 2, row => { row.ssh_alias = 'different'; })).toThrow('identity');
    expect(() => f.store.change(initial.id, 2, row => { row.plan.supported = false; })).toThrow('fixed plan');
    expect(() => f.store.change(initial.id, 2, async () => {})).toThrow('synchronous');
    const unknown = f.store.change(initial.id, 2, row => { row.status = 'unknown'; });
    expect(() => f.store.create(body('planned'))).toThrow('unresolved');
    expect(() => f.store.create(body('running'))).toThrow('unresolved');
    expect(f.store.create(body('planned', 'other')).revision).toBe(1);
    const ready = f.store.change(initial.id, unknown.revision, row => { row.status = 'ready'; row.runner_id = 'installation'; });
    expect(() => f.store.change(initial.id, ready.revision, row => { row.runner_id = 'other'; })).toThrow('identity');
    expect(f.store.read(initial.id)).toEqual(ready);
  } finally { f.close(); }
});

test('receipt storage rejects symlinks, hardlinks, wrong modes, corrupt/oversize records and directory replacement without repairing or disclosing contents', () => {
  const f = fixture();
  try {
    const row = f.store.create(body()), file = path.join(f.home, 'runner-deployments.json'), original = fs.readFileSync(file);
    const outside = path.join(f.root, 'outside'); fs.writeFileSync(outside, 'private-secret', { mode: 0o600 });
    fs.unlinkSync(file); fs.symlinkSync(outside, file);
    expect(() => f.store.list()).toThrow('safely read'); expect(fs.readFileSync(outside, 'utf8')).toBe('private-secret');
    fs.unlinkSync(file); fs.linkSync(outside, file); expect(() => f.store.list()).toThrow('safely read');
    fs.unlinkSync(file); fs.writeFileSync(file, original, { mode: 0o600 }); fs.chmodSync(file, 0o644);
    expect(() => f.store.list()).toThrow('safely read'); fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, '{"private-secret":');
    try { f.store.list(); throw new Error('not rejected'); } catch (error) { expect(error.message).not.toContain('private-secret'); }
    fs.writeFileSync(file, original);
    expect(() => f.store.change(row.id, 1, receipt => { receipt.private_data.large = 'private-secret'.repeat(400000); })).toThrow('limit');
    expect(f.store.read(row.id).revision).toBe(1);
    const swapped = new DeploymentStore(f.config, { before_publish() { fs.renameSync(f.home, `${f.home}-original`); fs.mkdirSync(path.join(f.root, 'external'), { mode: 0o700 }); fs.symlinkSync(path.join(f.root, 'external'), f.home); } });
    expect(() => swapped.change(row.id, 1, receipt => { receipt.status = 'running'; })).toThrow();
    expect(fs.readdirSync(path.join(f.root, 'external'))).toEqual([]);
    expect(new DeploymentStore({ home: `${f.home}-original` }).read(row.id).revision).toBe(1);
  } finally { f.close(); }
});

test('replacement receipt or lock identity before publication refuses overwrite', () => {
  const f = fixture();
  try {
    const row = f.store.create(body()), file = path.join(f.home, 'runner-deployments.json');
    const changed = new DeploymentStore(f.config, { before_publish() { const data = JSON.parse(fs.readFileSync(file, 'utf8')); data.items[0].revision++; fs.writeFileSync(file, JSON.stringify(data)); } });
    expect(() => changed.change(row.id, 1, value => { value.status = 'running'; })).toThrow('changed');
    expect(f.store.read(row.id).revision).toBe(2); expect(f.store.read(row.id).status).toBe('planned');
    const lockSwap = new DeploymentStore(f.config, { before_publish() { fs.renameSync(path.join(f.home, '.runner-deployments.lock'), path.join(f.home, 'old-lock')); fs.writeFileSync(path.join(f.home, '.runner-deployments.lock'), '', { mode: 0o600 }); } });
    expect(() => lockSwap.change(row.id, 2, value => { value.status = 'running'; })).toThrow('identity');
    expect(f.store.read(row.id).revision).toBe(2);
  } finally { f.close(); }
});

test('cross-process CAS admits one publisher; kernel deployment lock releases on process crash without stale-lock guessing', async () => {
  const f = fixture();
  try {
    const row = f.store.create(body()), script = path.join(f.root, 'process.js');
    fs.writeFileSync(script, `import fs from 'node:fs'; import {DeploymentStore} from ${JSON.stringify(path.resolve('src/core/runner-deployment-store.js'))};
const [home,id,mode] = process.argv.slice(2); const store=new DeploymentStore({home}, {before_publish: mode==='crash' ? ()=>{fs.writeSync(1,'locked\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);} : null});
try { store.change(id,1,row=>{row.status='running';}); process.exit(0); } catch { process.exit(1); }
`);
    const env = { PATH: '/usr/bin:/bin' }, crashing = Bun.spawn([process.execPath, script, f.home, row.id, 'crash'], { env, stdout: 'pipe', stderr: 'pipe' });
    const reader = crashing.stdout.getReader(); const locked = await reader.read(); expect(new TextDecoder().decode(locked.value)).toContain('locked');
    expect(() => f.store.change(row.id, 1, value => { value.status = 'running'; })).toThrow('busy');
    crashing.kill('SIGKILL'); await crashing.exited; reader.releaseLock();
    expect(f.store.read(row.id).revision).toBe(1);
    const processes = [0, 1].map(() => Bun.spawn([process.execPath, script, f.home, row.id, 'change'], { env, stdout: 'pipe', stderr: 'pipe' }));
    const codes = await Promise.all(processes.map(async child => { await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]); return child.exited; }));
    expect(codes.sort()).toEqual([0, 1]); expect(f.store.read(row.id).revision).toBe(2);
  } finally { f.close(); }
});
