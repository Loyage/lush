import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash } from '../src/runner/protocol.js';
import { remoteRuntime } from '../src/core/runner-deployment-remote-runtime.js';
import { remoteFixture, tar } from './runner-deployment-remote-fixture.js';

const entries = [{ name: 'bin/lush-runner', bytes: Buffer.from('fixture entry, not a real Runner') },
  { name: 'src/runner/index.js', bytes: Buffer.from('fixture source') },
  { name: 'src/runner/command-child.js', bytes: Buffer.from('dynamic fixture source') }];

test('controlled SSH prepares an installation, uploads native Bun/source over stdio, configures and seals it', async () => {
  const f = remoteFixture();
  try {
    const runtime = f.artifact(fs.readFileSync(process.execPath)), runner = f.artifact(tar(entries), entries.map(e => e.name));
    const c = await f.plan(undefined, { runtime, runner });
    expect(await c.remote.prepare(c)).toMatchObject({ ok: true, stage: 'prepare' });
    expect(await c.remote.upload({ ...c, kind: 'runtime', artifact: runtime })).toMatchObject({ ok: true, sha256: runtime.sha256 });
    expect(await c.remote.upload({ ...c, kind: 'runner', artifact: runner })).toMatchObject({ ok: true });
    const root = c.plan.install_root;
    expect(fs.readFileSync(path.join(root, 'runner/src/runner/command-child.js'), 'utf8')).toBe('dynamic fixture source');
    const config = { version: 1, node_id: randomUUID(), root: `${root}/workspaces`, cgroup_root: c.plan.cgroup.path,
      machine_token_hash: '1'.repeat(64), projects: { fixture: { control_token_hash: '2'.repeat(64) } } };
    // Only this cgroup observation is adapted; no claim of real cgroup installation or Runner handshake.
    const request = { id: c.id, plan: c.plan, plan_sha256: c.plan_sha256 };
    const configured = await remoteRuntime({ ...request, operation: 'configure', node_config: config }, { verifyCgroup: () => true });
    expect(configured.ok).toBe(true); expect(configured.managed.manifest_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'config.json')))).toEqual(config);
    expect(await remoteRuntime({ ...request, operation: 'inspect' }, { verifyCgroup: () => true })).toMatchObject({ integrity: 'verified', sealed: false });
    const proof = { node_id: config.node_id, runner_id: randomUUID(), execution_id: 'cmd-' + hash(`fixture:${randomUUID()}`), stopped: true, verified_at: new Date().toISOString() };
    expect(await remoteRuntime({ ...request, operation: 'seal', proof }, { verifyCgroup: () => true })).toMatchObject({ ok: true, runner_id: proof.runner_id });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'sealed'))).execution_id).toBe(proof.execution_id);
    expect(await remoteRuntime({ ...request, operation: 'inspect' }, { verifyCgroup: () => true })).toMatchObject({ integrity: 'verified', sealed: true });
  } finally { await f.close(); }
});
