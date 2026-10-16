import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeploymentStore } from '../src/core/runner-deployment-store.js';
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-test-deployment-lease-')), home = path.join(root, 'device'), config = { home };
  const body = alias => ({ status: 'planned', ssh_alias: alias, name: 'Fixture', project_id: 'project-a',
    plan: { target: { uid: 1000 }, supported: true }, stages: [], private_data: { remote: { machine_id: 'same-machine' }, plan_sha256: 'a'.repeat(64), plan_proof: { abi: 'fixed' } } });
  return { root, home, config, body, store: new DeploymentStore(config), close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
test('long deployment lease excludes another owner but not reads, other deployments or short receipt publication', () => {
  const f = fixture(); let first, other;
  try {
    expect(f.store.isActive('00000000-0000-4000-8000-000000000001')).toBe(false); expect(fs.existsSync(f.home)).toBe(false);
    const a = f.store.create(f.body('alias-a')), b = f.store.create(f.body('alias-b'));
    first = f.store.lease(a.id); expect(f.store.isActive(a.id)).toBe(true);
    expect(() => new DeploymentStore(f.config).lease(a.id)).toThrow('already executing');
    other = f.store.lease(b.id); expect(f.store.isActive(b.id)).toBe(true);
    expect(f.store.list().items).toHaveLength(2);
    const active = f.store.change(a.id, a.revision, row => { row.status = 'running'; }, { guard: first.assert });
    // Both plans already existed. Claiming B must still catch A, including different aliases to one UID/machine.
    expect(() => f.store.change(b.id, b.revision, row => { row.status = 'running'; }, { guard: other.assert })).toThrow('unresolved');
    expect(() => f.store.create(f.body('alias-c'))).toThrow('unresolved');
    expect(f.store.read(a.id).revision).toBe(active.revision);
    first.release(); first.release(); expect(f.store.isActive(a.id)).toBe(false); expect(() => first.assert()).toThrow('released');
    expect(() => f.store.change(a.id, active.revision, row => { row.private_data.remote.machine_id = 'different'; })).toThrow('fixed plan');
    expect(() => f.store.change(a.id, active.revision, row => { row.private_data.plan_proof.abi = 'different'; })).toThrow('fixed plan');
    const unknown = f.store.change(a.id, active.revision, row => { row.status = 'unknown'; });
    expect(() => f.store.change(a.id, unknown.revision, row => { row.status = 'running'; })).toThrow('replayed');
    expect(f.store.read(a.id).status).toBe('unknown');
  } finally { first?.release(); other?.release(); f.close(); }
});

test('lease publication guard detects replaced inode and unsafe links/mode without modifying the replacement', () => {
  const f = fixture(); let lease;
  try {
    const row = f.store.create(f.body('alias-a')), lock = path.join(f.home, `.runner-deployment-${row.id}.lock`);
    lease = f.store.lease(row.id);
    const guarded = new DeploymentStore(f.config, { before_publish() { fs.renameSync(lock, `${lock}.original`); fs.writeFileSync(lock, 'replacement', { mode: 0o600 }); } });
    expect(() => guarded.change(row.id, 1, receipt => { receipt.status = 'running'; }, { guard: lease.assert })).toThrow('identity');
    expect(f.store.read(row.id).revision).toBe(1); expect(fs.readFileSync(lock, 'utf8')).toBe('replacement');
    lease.release(); fs.unlinkSync(lock); fs.symlinkSync(`${lock}.original`, lock);
    expect(() => f.store.lease(row.id)).toThrow(); expect(() => f.store.isActive(row.id)).toThrow();
    fs.unlinkSync(lock); fs.linkSync(`${lock}.original`, lock); expect(() => f.store.lease(row.id)).toThrow('identity');
    fs.unlinkSync(lock); fs.writeFileSync(lock, '', { mode: 0o600 }); fs.chmodSync(lock, 0o644); expect(() => f.store.lease(row.id)).toThrow('identity');
  } finally { lease?.release(); f.close(); }
});

test('process crash releases operation lease but preserves running receipt for explicit non-replaying reconciliation', async () => {
  const f = fixture(); let child, reader;
  try {
    const row = f.store.create(f.body('alias-a')), script = path.join(f.root, 'owner.js');
    fs.writeFileSync(script, `import fs from 'node:fs'; import {DeploymentStore} from ${JSON.stringify(path.resolve('src/core/runner-deployment-store.js'))};
const [home,id]=process.argv.slice(2), store=new DeploymentStore({home}); const lease=store.lease(id);
store.change(id,1,row=>{row.status='running';},{guard:lease.assert}); fs.writeSync(1,'owned\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);`);
    child = Bun.spawn([process.execPath, script, f.home, row.id], { env: { PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe' });
    reader = child.stdout.getReader(); const chunk = await reader.read(); expect(new TextDecoder().decode(chunk.value)).toContain('owned');
    expect(f.store.isActive(row.id)).toBe(true); expect(() => f.store.lease(row.id)).toThrow('executing');
    child.kill('SIGKILL'); await child.exited;
    expect(f.store.isActive(row.id)).toBe(false); expect(f.store.read(row.id).status).toBe('running');
    const lease = f.store.lease(row.id);
    try { const unknown = f.store.change(row.id, 2, receipt => { receipt.status = 'unknown'; }, { guard: lease.assert }); expect(unknown.status).toBe('unknown'); }
    finally { lease.release(); }
    expect(() => f.store.create(f.body('alias-new'))).toThrow('unresolved');
  } finally { if (child) { child.kill('SIGKILL'); await child.exited; await new Response(child.stderr).text(); } reader?.releaseLock(); f.close(); }
});
