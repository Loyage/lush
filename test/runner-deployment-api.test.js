import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { RUNNER_METHODS, validateRunnerParams, runnerManagement, publicRunnerResult } from '../src/rpc/runner-methods.js';
import { USER_ONLY, PARAMS, assertAllowed } from '../src/rpc/registry.js';
import { HANDLERS } from '../src/rpc/dispatcher.js';
import { CLI_COMMANDS, LUSHC_METHODS } from '../src/cli/catalog.js';
import { DEVICE_SETTINGS_ACTIONS, DeviceSettingsService } from '../src/host/device-settings.js';
import { run } from '../src/cli/commands/runner.js';
import { managementFixture } from './runner-management-fixture.js';
import { deploymentApiFixture, deploymentId, deploymentRequests } from './runner-deployment-api-fixture.js';
import { readDeviceManagementPermissions, saveDeviceManagementPermissions } from '../src/core/management-permissions.js';

const words = method => RUNNER_METHODS[method].cli.split(' ').slice(1);
const methods = Object.keys(deploymentRequests);
const entrypoints = ['planDeployment', 'applyDeployment', 'confirmDeployment', 'reconcileDeployment', 'planDeploymentRecovery', 'applyDeploymentRecovery', 'reconcileDeploymentRecovery'];

test('deployment mutations have one user-only registry/Host/CLI surface and explicitly dispatch every private entrypoint with its revision intact', async () => {
  expect(Object.keys(RUNNER_METHODS).filter(key => key.startsWith('runner.deployments.') && !key.endsWith('.get'))).toEqual(methods);
  const calls = [], service = Object.fromEntries(entrypoints.map(entry => [entry, async params => { calls.push({ entry, params }); return { id: deploymentId, revision: 1, status: 'unknown', private_data: { raw: 'PRIVATE-MUTATION' } }; }]));
  for (const [index, method] of methods.entries()) {
    const params = structuredClone(deploymentRequests[method]); validateRunnerParams(method, params);
    expect(PARAMS[method]).toEqual(RUNNER_METHODS[method].params); expect(typeof HANDLERS[method]).toBe('function');
    expect(USER_ONLY.has(method)).toBe(true); expect(LUSHC_METHODS.has(method)).toBe(false); expect(DEVICE_SETTINGS_ACTIONS.has(method)).toBe(true);
    expect(CLI_COMMANDS.find(item => item.path === RUNNER_METHODS[method].cli).rpc).toEqual([method]);
    expect(() => assertAllowed(method, params, 7)).toThrow('user approval');
    const result = publicRunnerResult(await runnerManagement(service, method, params), method);
    expect(calls.at(-1)).toEqual({ entry: entrypoints[index], params }); expect(calls).toHaveLength(index + 1);
    expect(result.status).toBe('unknown'); expect(JSON.stringify(result)).not.toContain('PRIVATE-');
    expect(publicRunnerResult(result, method)).toEqual(result);
  }
});

test('deployment schemas refuse ambient authority, bad identities/revisions, incomplete confirmation and unknown/duplicate actions before dispatch', () => {
  for (const method of methods) {
    const sample = deploymentRequests[method];
    for (const key of ['force', 'command', 'root', 'path', 'source_url', 'ssh_configuration', 'runtime_generation', 'machine_token', '_token', '_management_proxy'])
      expect(() => validateRunnerParams(method, { ...sample, [key]: 'PRIVATE' })).toThrow();
    const invalid = method.endsWith('.plan') && !method.includes('.recovery.')
      ? [{ ssh_alias: 'user@host' }, { name: 'bad\nname' }, { name: '' }, { project_id: '../project' }]
      : [{ id: '../path' }, { id: null }, { expected_revision: '1' }, { expected_revision: 0 }, { expected_revision: -1 }];
    if ('confirm' in sample) invalid.push({ confirm: false }, { confirm: 'true' });
    if ('approved_actions' in sample) { const action = method.includes('.recovery.') ? 'bind_runtime_generation' : 'node_register'; invalid.push({ approved_actions: 'all' }, { approved_actions: ['unknown'] }, { approved_actions: [action, action] }); }
    if ('runner_id' in sample) invalid.push({ runner_id: '' }, { runner_id: '../runner' });
    if ('recovery_id' in sample) invalid.push({ recovery_id: '' }, { recovery_id: 'legacy' });
    for (const patch of invalid) expect(() => validateRunnerParams(method, { ...sample, ...patch })).toThrow();
  }
});

test('every deployment CLI verb including nested recovery reads a private file once, preserves exact payload and never adds read-back/retry', async () => {
  const f = await managementFixture();
  try {
    for (const method of methods) {
      const params = deploymentRequests[method], file = f.file(params), calls = [];
      const result = await run('runner', [...words(method), '--file', file], { client: { token: null, async request(method, params) { calls.push({ method, params }); return { id: deploymentId, status: 'unknown', private_data: { secret: 'PRIVATE' } }; } } });
      expect(calls).toEqual([{ method, params }]); expect(result.status).toBe('unknown'); expect(JSON.stringify(result)).not.toContain('PRIVATE');
      const invoke = args => run('runner', args, { client: { token: null, request() { throw Error('Unexpected dispatch'); } } });
      for (const args of [[...words(method), '--file', '-'], [...words(method), '--file', file, '--file', file], [...words(method), '--file', file, '--force'], [...words(method), JSON.stringify(params)]])
        await expect(invoke(args)).rejects.toThrow();
      await expect(run('runner', [...words(method), '--file', file], { client: { token: 'agent', request() { throw Error('Unexpected dispatch'); } } })).rejects.toThrow('user only');
      fs.chmodSync(file, 0o644); await expect(invoke([...words(method), '--file', file])).rejects.toThrow('owner-only'); fs.chmodSync(file, 0o600);
      const link = file + '.link'; fs.symlinkSync(file, link); await expect(invoke([...words(method), '--file', link])).rejects.toThrow('owner-only');
      fs.writeFileSync(file, '{"PRIVATE"'); await expect(invoke([...words(method), '--file', file])).rejects.toThrow('owner-only');
      fs.writeFileSync(file, ' '.repeat(128 * 1024) + JSON.stringify(params)); await expect(invoke([...words(method), '--file', file])).rejects.toThrow('owner-only');
    }
    expect(f.connections()).toBe(0); expect(f.deployments.list().items).toEqual([]);
  } finally { await f.close(); }
});

test('real user CLI -> Unix RPC -> actual deployment service -> controlled SSH probe returns blocked without prepare/upload/registration/pairing or fabricated readiness', async () => {
  const f = await deploymentApiFixture();
  try {
    const before = f.store.all('SELECT id,status FROM tasks');
    const response = await f.cli(['runner', ...words('runner.deployments.plan'), '--file', f.file(deploymentRequests['runner.deployments.plan'])]);
    expect(response).toMatchObject({ code: 0, err: '' }); const planned = JSON.parse(response.out);
    expect(planned.status).toBe('blocked'); expect(planned.plan.supported).toBe(false); expect(planned.runner_id).toBeUndefined();
    expect(planned.plan.blockers.some(b => b.code.startsWith('cgroup_'))).toBe(true);
    expect(f.remote.records).toHaveLength(1); expect(f.remote.records[0]).toMatchObject({ command: 'ssh', mode: 0o600 });
    expect(f.builds).toBe(1); expect(f.cleanups).toBe(1); expect(fs.readdirSync(f.remote.home)).toEqual([]);
    const stored = f.plans.store.read(planned.id);
    expect(stored.stages.map(s => s.id)).toEqual(['prepare_artifacts', 'probe']); expect(stored.private_data.local).toBeUndefined();
    for (const secret of [stored.private_data.remote.machine_id, stored.private_data.remote.boot_id, stored.private_data.ssh_sha256, 'private_data', 'fixture.invalid']) expect(response.out).not.toContain(secret);
    for (const method of methods.filter(m => !['runner.deployments.plan', 'runner.deployments.reconcile'].includes(m))) {
      const params = { ...deploymentRequests[method], id: planned.id, expected_revision: f.plans.store.read(planned.id).revision,
        ...(method === 'runner.deployments.apply' ? { approved_actions: planned.plan.actions.map(a => a.id) } : {}) };
      const result = await f.cli(['runner', ...words(method), '--file', f.file(params)]);
      expect(result.code).toBe(1); expect(result.out).toBe(''); expect(f.remote.records).toHaveLength(1);
    }
    const observed = await f.cli(['runner', ...words('runner.deployments.reconcile'), '--file', f.file({ id: planned.id, expected_revision: f.plans.store.read(planned.id).revision })]);
    expect(observed.code).toBe(0); expect(JSON.parse(observed.out)).toMatchObject({ status: 'blocked', observation: { status: 'complete' } });
    expect(f.remote.records).toHaveLength(1); expect(f.connections()).toBe(0); expect(f.store.all('SELECT id,status FROM tasks')).toEqual(before);
    expect(f.store.runnerProject().project_id).toBeNull(); expect(f.project.runners.readNodes().nodes).toEqual([]); expect(f.project.runners.readCredentials().nodes).toEqual([]);
    const read = await f.cli(['runner', 'deployments', 'get', '--scope', 'device']); expect(read.code).toBe(0); expect(JSON.parse(read.out).items[0].status).toBe('blocked');
    expect(f.project.writing).toBe(0);
  } finally { await f.close(); }
});

test('deployment RPC/CLI unsafe snapshot and Agent/Valet/management proxies reject under shared device policy before artifacts, SSH or receipt creation', async () => {
  const f = await deploymentApiFixture();
  try {
    const draft = readDeviceManagementPermissions(f.config);
    const saved = saveDeviceManagementPermissions(f.config, draft.permissions, draft.revision);
    expect(f.project.managementPermissions()).toMatchObject({ scope: 'device', revision: saved.revision });
    for (const method of methods) expect(saved.permissions[method]).toBe('unavailable');
    f.snapshot = { status: 'ok', limited: true, configuration: 'PRIVATE' };
    const method = 'runner.deployments.plan', params = deploymentRequests[method], result = await f.cli(['runner', ...words(method), '--file', f.file(params)]);
    expect(result.code).toBe(1); expect(result.err).not.toContain('PRIVATE');
    for (const method of methods) {
      const params = deploymentRequests[method];
      await expect(f.dispatcher.dispatch(method, { ...params, _token: 'invalid-agent-token' })).rejects.toThrow();
      await expect(f.project.managementDispatch(method, params, 7)).rejects.toThrow();
      const denied = await f.cli(['runner', ...words(method), '--file', f.file(params)], { executable: 'lushc' }); expect(denied.code).toBe(1);
    }
    expect(f.builds).toBe(0); expect(f.remote.records).toEqual([]); expect(f.deployments.list().items).toEqual([]); expect(f.connections()).toBe(0);
  } finally { await f.close(); }
});

test('lost controlled probe ACK stays unknown, original observation does not resend and another plan cannot bypass unresolved alias', async () => {
  const f = await deploymentApiFixture();
  try {
    f.remote.hook(() => ({ drop_ack: true }));
    const planned = await f.cli(['runner', 'deployments', 'plan', '--file', f.file(deploymentRequests['runner.deployments.plan'])]);
    expect(planned.code).toBe(0); const record = JSON.parse(planned.out); expect(record.status).toBe('unknown');
    expect(f.remote.records).toHaveLength(1); expect(f.cleanups).toBe(1);
    const observed = await f.cli(['runner', 'deployments', 'reconcile', '--file', f.file({ id: record.id, expected_revision: record.revision })]);
    expect(observed.code).toBe(0); expect(JSON.parse(observed.out)).toMatchObject({ status: 'unknown', observation: { status: 'complete' } });
    const retry = await f.cli(['runner', 'deployments', 'plan', '--file', f.file(deploymentRequests['runner.deployments.plan'])]);
    expect(retry.code).toBe(1); expect(f.builds).toBe(1); expect(f.remote.records).toHaveLength(1); expect(fs.readdirSync(f.remote.home)).toEqual([]);
  } finally { await f.close(); }
});

test('device command parser -> actual Host service retains fail-closed validation without selecting or starting a project', async () => {
  const f = await deploymentApiFixture(); let device;
  try {
    f.snapshot = { status: 'unavailable', limited: true, configuration: '' };
    device = new DeviceSettingsService(f.config.env, { runner: f.runnerOptions });
    const client = { token: null, request: (method, params) => device.request(method, params) };
    await expect(run('runner', ['deployments', 'plan', '--file', f.file(deploymentRequests['runner.deployments.plan'])], { client })).rejects.toThrow();
    expect(f.builds).toBe(0); expect(f.remote.records).toEqual([]); expect(f.deployments.list().items).toEqual([]); expect(f.project._runners).toBeUndefined();
  } finally { await device?.stop(); await f.close(); }
});

test('unexpected deployment exceptions never reflect raw private diagnostics or recommend replaying a mutation', async () => {
  for (const method of methods) {
    const service = Object.fromEntries(entrypoints.map(entry => [entry, () => { throw Error('PRIVATE-MACHINE-TOKEN SCRIPT STDOUT'); }]));
    try { await runnerManagement(service, method, deploymentRequests[method]); throw Error('Failure injection not reached'); }
    catch (error) { expect(error.message).toContain('do not retry'); expect(error.message).not.toContain('PRIVATE-'); }
  }
});
