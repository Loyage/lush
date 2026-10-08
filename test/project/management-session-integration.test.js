import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, setDefaultTimeout } from 'bun:test';
import { fixture, repo } from '../helpers.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { RPCServer } from '../../src/rpc/server.js';
import { RPCClient } from '../../src/rpc/client.js';
import { createSignal } from '../../src/signal.js';
import { sessionFiles } from '../../src/core/transcript.js';
import { readUsageStatistics } from '../../src/core/usage-statistics.js';
setDefaultTimeout(20000);

async function setup() {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  f.target = (await f.project.order('ordinary target', 'main', [], null, false)).task;
  let clock = Date.parse('2030-01-01T00:00:00Z');
  f.project.scheduledHookOptions = { now: () => clock, setTimeout: () => 1, clearTimeout: () => {} };
  f.advance = ms => { clock += ms; };
  const signal = f.project.saveHookSignal({ name: 'account clock', schedule: { kind: 'once',
    at: '2030-01-01T00:01:00Z', timezone: 'UTC' } }, f.project.hookSignals().revision).signals.items[0];
  f.managerProfile = { agent: 'pi', config_mode: 'pi', env: { RUNTIME_ENV_SENTINEL: 'development-private-environment' } };
  f.manager = f.project.createManagementWorker({ name: 'restricted manager', instruction: `start ${f.target.worker_number}`,
    signal_id: signal.id, profile: f.managerProfile, client_request_id: 'merged-source-test' });
  return f;
}

test('isolated management session names remain readable, attributable and exactly deletable without touching similarly numbered sessions', async () => {
  const f = await setup();
  try {
    const directory = path.join(f.config.home, 'sessions'); fs.mkdirSync(directory, { recursive: true });
    const files = [`old_lush-manager-${f.manager.id}.jsonl`, `new_lush-manager-${f.manager.id}-pi.jsonl`];
    for (const [index, name] of files.entries()) fs.writeFileSync(path.join(directory, name), JSON.stringify({ type: 'message',
      timestamp: '2026-01-01T00:00:01.000Z', lush: { task_id: f.manager.id, role: 'manager', run_id: index + 100 },
      message: { role: 'assistant', content: [{ type: 'text', text: `manager answer ${index}` }],
        usage: { input: 10, output: 2, totalTokens: 12, cost: { total: 0.1 } } } }) + '\n');
    const unrelated = path.join(directory, `other_lush-manager-${f.manager.id}0.jsonl`); fs.writeFileSync(unrelated, '{}\n');
    expect(sessionFiles(f.config, f.manager.id).sort()).toEqual(files.sort());
    expect(f.project.transcript(f.manager.id).steps.filter(step => step.kind === 'text')).toHaveLength(2);
    expect((await f.project.transcriptLatest(f.manager.id)).steps.filter(step => step.kind === 'text')).toHaveLength(2);
    expect((await f.project.searchTranscript(f.manager.id, { query: 'manager answer' })).steps).toHaveLength(2);
    expect(f.project.usage(f.manager.id).totals.tokens).toBe(24);
    const usage = await readUsageStatistics(f.config);
    expect(usage.roles).toMatchObject([{ role: 'manager', requests: 2, tokens: 24 }]);
    f.project.cancel(f.manager.id);
    const preview = await f.project.deleteTaskPreview(f.manager.id);
    expect(preview.blockers).toEqual([]);
    expect(preview.resources.files).toEqual(files.map(name => path.join(directory, name)).sort());
    await f.project.deleteTask(f.manager.id, { revision: preview.revision, confirm: true });
    for (const name of files) expect(fs.existsSync(path.join(directory, name))).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true);
  } finally { await f.close(); }
});

test('merged runtime, restricted Provider environment and trusted RPC bridge share the same live occurrence authorization', async () => {
  const f = await setup(); let rpc;
  try {
    const helper = fileURLToPath(new URL('../../src/agent/management-rpc.js', import.meta.url));
    const fakePi = path.join(f.root, 'controlled-pi');
    fs.writeFileSync(fakePi, `#!/usr/bin/env bun
import fs from 'node:fs';
import { runManagementRPC } from ${JSON.stringify(helper)};
const input = JSON.parse(fs.readFileSync(process.argv.find(arg => arg.startsWith('@')).slice(1), 'utf8'));
if (input.task.role !== 'manager' || input.task.management || input.task.retry_profile) throw new Error('unsafe startup');
if (process.env.RUNTIME_ENV_SENTINEL || JSON.stringify(input).includes('development-private-environment')) throw new Error('unsafe management environment');
const target = await runManagementRPC('worker.lookup', {number:${JSON.stringify(f.target.worker_number)}});
const query = await runManagementRPC('manager.query', {id:target.id});
const result = await runManagementRPC('manager.start', {id:target.id});
const duplicate = await runManagementRPC('manager.start', {id:target.id});
if (query.status !== 'paused' || result.status !== 'succeeded' || duplicate.receipt_id !== result.receipt_id) throw new Error('bad runtime seam');
console.log(JSON.stringify({signal:input.management.signal.id,result}));
`, { mode: 0o755 });
    f.config.env.LUSH_PI_COMMAND = fakePi;
    f.project.provider = new AgentProvider(f.config, f.project.agentSettings);
    rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {})); await rpc.start();
    const client = new RPCClient(f.config.socket, 25);
    const raw = JSON.parse(f.store.task(f.manager.id).management);
    const publicReceipt = await client.request('management.create', { name: f.manager.name, instruction: f.manager.goal,
      signal_id: raw.signal_id, profile: f.managerProfile, client_request_id: 'merged-source-test' });
    expect(publicReceipt.task.id).toBe(f.manager.id);
    expect(publicReceipt.task.management.can_enable).toBe(true);
    f.advance(60000); f.project.observeScheduledTaskHooks();
    const occurrence = f.project.managementView(f.manager.id).pending_signal.id;
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    expect(f.store.task(f.manager.id).status).toBe('completed');
    expect(JSON.parse(f.store.task(f.manager.id).result)).toMatchObject({ signal: occurrence, result: { status: 'succeeded', target_id: f.target.id } });
    expect(f.store.task(f.target.id).status).toBe('queued');
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='task.resumed'").n).toBe(1);
    expect(f.project.managementView(f.manager.id).can_enable).toBe(false);
  } finally { await rpc?.close(); await f.close(); }
});
