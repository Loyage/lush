import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { IMPLEMENTATION_VERSION } from '../src/runner/protocol.js';
import { RUNNER_METHODS } from '../src/rpc/runner-methods.js';
import { USER_ONLY } from '../src/rpc/registry.js';
import { HANDLERS } from '../src/rpc/dispatcher.js';
import { deploymentApiFixture, deploymentRequests } from './runner-deployment-api-fixture.js';

test('user CLI -> registered Unix RPC -> deployment service -> controlled SSH probe returns an honest blocked plan', async () => {
  const method = 'runner.deployments.plan';
  expect(USER_ONLY.has(method)).toBe(true); expect(typeof HANDLERS[method]).toBe('function');
  const f = await deploymentApiFixture();
  let builds = 0, cleanups = 0;
  // Packaging is controlled here: the host executable may have an unsupported deployment ABI.
  // The actual CLI/RPC/service and SSH subprocess remain real; no installation is attempted.
  f.plans.build_artifacts = async () => {
    builds++;
    return { runtime: { ...f.remote.artifact(Buffer.from('controlled runtime snapshot')), version: Bun.version,
      source: 'central-bun', os: 'linux', arch: process.arch, abi: { ...f.remote.abi, supported: true } },
      runner: { ...f.remote.artifact(Buffer.from('controlled runner snapshot')), version: IMPLEMENTATION_VERSION },
      files: ['src/runner/index.js'], cleanup() { cleanups++; } };
  };
  try {
    const before = f.store.all('SELECT id,status FROM tasks');
    const response = await f.cli(['runner', ...RUNNER_METHODS[method].cli.split(' ').slice(1), '--file', f.file(deploymentRequests[method])]);
    expect(response).toMatchObject({ code: 0, err: '' });
    const planned = JSON.parse(response.out);
    if (planned.status !== 'blocked') console.error('controlled deployment plan diagnostic', planned);
    expect(planned.status).toBe('blocked'); expect(planned.plan.supported).toBe(false);
    expect(planned.plan.blockers.some(b => b.code.startsWith('cgroup_'))).toBe(true);
    expect(f.remote.records).toHaveLength(1); expect(f.remote.records[0]).toMatchObject({ command: 'ssh' });
    expect(builds).toBe(1); expect(cleanups).toBe(1); expect(fs.readdirSync(f.remote.home)).toEqual([]);
    expect(f.plans.store.read(planned.id).stages.map(s => s.id)).toEqual(['prepare_artifacts', 'probe']);
    const read = await f.cli(['runner', 'deployments', 'get', '--scope', 'device']);
    expect(read.code).toBe(0); expect(JSON.parse(read.out).items[0].status).toBe('blocked');
    expect(f.connections()).toBe(0); expect(f.store.all('SELECT id,status FROM tasks')).toEqual(before);
    expect(f.project.runners.readNodes().nodes).toEqual([]); expect(f.project.runners.readCredentials().nodes).toEqual([]);
  } finally { await f.close(); }
});
