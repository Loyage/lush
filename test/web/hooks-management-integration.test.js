import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, setDefaultTimeout } from 'bun:test';
import { repo, git } from '../helpers.js';
import { setup, fetch } from './harness.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { hookSchedule } from '../../src/ui/web/assets/hook-schedule.js';
setDefaultTimeout(20000);

async function get(f, route) {
  const response = await fetch(f.url + route); expect(response.status).toBe(200); return response.json();
}
async function action(f, method, params) {
  const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }) });
  const value = await response.json(); expect(response.status).toBe(200); return value;
}
async function prepared(targets) {
  const f = await setup(); f.project.kick = () => {};
  try {
    await repo(f.root);
    let now = Date.parse('2030-01-01T00:00:00Z');
    f.advance = ms => { now += ms; };
    f.project.scheduledHookOptions = { now: () => now, setTimeout: () => 1, clearTimeout: () => {} };
    f.targets = [];
    for (const operation of targets) {
      const task = (await action(f, 'order.submit', { content: `ordinary ${operation} target`, branch: 'main', start: false,
        profile: { agent: 'pi', model: 'test/target-codex', env: { TARGET_ONLY: 'PRIVATE_TARGET_ENV' } } })).task;
      if (operation === 'retry') f.store.update(task.id, { status: 'failed', error: 'quota unavailable' });
      f.targets.push({ ...task, operation, profile: f.store.task(task.id).retry_profile });
    }
    const helper = fileURLToPath(new URL('../../src/agent/management-rpc.js', import.meta.url));
    const command = path.join(f.root, 'controlled-management-pi');
    fs.writeFileSync(command, `#!/usr/bin/env bun
import fs from 'node:fs';
import { runManagementRPC } from ${JSON.stringify(helper)};
const input = JSON.parse(fs.readFileSync(process.argv.find(arg => arg.startsWith('@')).slice(1), 'utf8'));
if (input.task.role !== 'manager' || input.task.management || input.task.retry_profile
  || process.env.MANAGER_PRIVATE || process.env.TARGET_ONLY || JSON.stringify(input).includes('PRIVATE_MANAGER_ENV')) throw new Error('unsafe management invocation');
const results = [];
for (const target of ${JSON.stringify(f.targets.map(({ operation, worker_number }) => ({ operation, worker_number })))}) {
  const lookup = await runManagementRPC('worker.lookup', {number:target.worker_number});
  const query = await runManagementRPC('manager.query', {id:lookup.id});
  const method = 'manager.' + target.operation;
  const receipt = await runManagementRPC(method, {id:lookup.id});
  const duplicate = await runManagementRPC(method, {id:lookup.id});
  if (receipt.receipt_id !== duplicate.receipt_id) throw new Error('duplicate action identity changed');
  results.push({query,receipt});
}
console.log(JSON.stringify({occurrence:input.management.signal.id,results}));
`, { mode: 0o755 });
    f.config.env.LUSH_PI_COMMAND = command;
    f.project.provider = new AgentProvider(f.config, f.project.agentSettings);
    f.definition = hookSchedule('once', '2030-01-01T08:01:00', '', 'Asia/Shanghai');
    let catalogue = await get(f, '/api/hooks');
    f.templateRevision = catalogue.revision; f.daemonRevision = catalogue.daemon_hooks.revision;
    catalogue = await action(f, 'hooks.signal_save', { expected_revision: catalogue.signals.revision,
      signal: { name: 'Quota clock is not quota proof', schedule: f.definition } });
    f.signal = catalogue.signals.items.at(-1); f.signalRevision = catalogue.signals.revision;
    f.request = { name: 'Dedicated clock manager', instruction: f.targets.map(task => `${task.operation} ${task.worker_number}`).join('; '),
      signal_id: f.signal.id, client_request_id: 'http-fixed-management-request',
      profile: { agent: 'pi', config_mode: 'pi', env: { MANAGER_PRIVATE: 'PRIVATE_MANAGER_ENV' } } };
    f.manager = (await action(f, 'management.create', f.request)).task;
    f.run = async () => {
      f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    };
    return f;
  } catch (error) { await f.close(); throw error; }
}

async function safeCatalogue(f) {
  const catalogue = await get(f, '/api/hooks');
  expect(catalogue.revision).toBe(f.templateRevision);
  expect(catalogue.daemon_hooks.revision).toBe(f.daemonRevision);
  expect(catalogue.signals.revision).toBe(f.signalRevision);
  expect(JSON.stringify(catalogue)).not.toContain('PRIVATE_');
  return catalogue;
}

test('browser schedule through HTTP, live manager RPC and controlled Pi starts/retries sibling targets once without new Git/Input or profile leaks', async () => {
  const f = await prepared(['start', 'retry']);
  try {
    const branches = await git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/heads');
    expect(f.manager).toMatchObject({ role: 'manager', task_kind: 'management', status: 'waiting', branch: null, input_id: null });
    expect(f.store.get('SELECT count(*) AS n FROM agent_runs').n).toBe(0);
    expect((await action(f, 'management.create', f.request)).task.id).toBe(f.manager.id);
    f.advance(60000); f.project.observeScheduledTaskHooks();
    const queued = (await safeCatalogue(f)).management_workers.find(task => task.id === f.manager.id);
    expect(queued.management).toMatchObject({ state: 'queued', pending_signal: { due_at: f.definition.at } });
    expect(queued.management.revision).toBe(f.manager.management.revision);
    await f.run();
    const detail = await get(f, `/api/worker/${f.manager.id}`);
    const result = JSON.parse(detail.result);
    expect(detail.status).toBe('completed'); expect(result.occurrence).toBe(queued.management.pending_signal.id);
    expect(result.results.map(item => item.query.status)).toEqual(['paused', 'failed']);
    expect(result.results.map(item => item.receipt.status)).toEqual(['succeeded', 'succeeded']);
    for (const target of f.targets) {
      expect(f.store.task(target.id).status).toBe('queued');
      expect(f.store.task(target.id).retry_profile).toBe(target.profile);
    }
    expect(f.store.task(f.manager.id).agent_token_hash).toBeNull();
    expect(fs.existsSync(path.join(detail.workspace, '.git'))).toBe(false);
    expect(await git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe(branches);
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(2);
    expect(f.store.get('SELECT count(*) AS n FROM agent_runs WHERE task_id=?', f.manager.id).n).toBe(1);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='management.action_completed'").n).toBe(2);
    const catalogue = await safeCatalogue(f);
    expect(catalogue.management_workers.find(task => task.id === f.manager.id).management).toMatchObject({ enabled: false, can_enable: false, state: 'succeeded' });
    expect(JSON.stringify(detail)).not.toContain('PRIVATE_');
    expect((await action(f, 'management.create', f.request)).task.id).toBe(f.manager.id); // Recover the receipt after consumption.
  } finally { await f.close(); }
});

test('HTTP management call returns durable waiting action; safe-point completion needs neither page reads nor another paid invocation', async () => {
  const f = await prepared(['start']);
  try {
    const target = f.targets[0]; f.project.workspaces.busy.add(target.id);
    f.advance(60000); f.project.observeScheduledTaskHooks(); await f.run();
    const detail = await get(f, `/api/worker/${f.manager.id}`);
    expect(JSON.parse(detail.result).results[0].receipt.status).toBe('waiting');
    expect(detail.status).toBe('waiting'); expect(f.store.task(target.id).status).toBe('paused');
    const pending = f.store.task(f.manager.id).management;
    await safeCatalogue(f); await safeCatalogue(f);
    expect(f.store.task(f.manager.id).management).toBe(pending); // Reads cannot execute queued operations.
    f.project.workspaces.busy.delete(target.id); f.project.drainManagementActions();
    const settled = (await safeCatalogue(f)).management_workers.find(task => task.id === f.manager.id);
    expect(settled.management).toMatchObject({ enabled: false, state: 'succeeded', pending_signal: null,
      last_execution: { actions_count: 1, actions: [{ status: 'succeeded', target_id: target.id }] } });
    expect(f.store.task(target.id).status).toBe('queued');
    expect(f.store.get('SELECT count(*) AS n FROM agent_runs WHERE task_id=?', f.manager.id).n).toBe(1);
    f.project.drainManagementActions(); f.project.observeScheduledTaskHooks();
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='task.resumed'").n).toBe(1);
  } finally { f.project.workspaces.busy.clear(); await f.close(); }
});
