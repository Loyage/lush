import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunnerNode } from '../../src/runner/node.js';
import { createCommandService } from '../../src/runner/commands.js';
import { hash } from '../../src/runner/protocol.js';
import { fixtureProcessAdapter } from '../runner/fixtures/command-process-adapter.js';

// Desired invariant: an expired/released Run may stop its own requests, not a later Run.
test('released Run cannot cancel a newer Run through lease.release', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-review-lease-'));
  const machine = hash('review-machine'), control = hash('review-control');
  const node = new RunnerNode({ root, node_id: 'node', machine_token_hash: hash(machine),
    projects: { project: { control_token_hash: hash(control) } }, memory_reserve_bytes: 1 });
  const commands = createCommandService({ store: node.store, config: node.config,
    process_adapter: { ...fixtureProcessAdapter(), availableMemory: () => 0 } });
  node.services = { ...commands.services, check_context() {} };
  node.preflight = commands.preflight;
  const session = node.openSession(); let sequence = 0;
  const base = { project_id: 'project', node_id: 'node', runner_id: node.runner_id,
    worker_id: 1, workspace_id: 'workspace', generation: 1 };
  const call = async (method, params = {}, run_id = null) => {
    const response = await node.dispatch({ version: 1, request_id: `review-${++sequence}`, method, params,
      identity: { ...base, ...(run_id === null ? { operation_id: 'control' } : { run_id }) },
      auth: { machine_token: machine, ...(run_id === null ? { control_token: control } : { run_token: hash(`run-${run_id}`) }) },
    }, session);
    if (response.error) throw Object.assign(new Error(response.error.message), response.error);
    return response.result;
  };
  try {
    await call('workspace.register');
    await call('lease.grant', { run_id: 1, run_token: hash('run-1') });
    await call('lease.release', {}, 1);
    await call('lease.grant', { run_id: 2, run_token: hash('run-2') });
    const started = await call('command.start', { script: 'printf should-run', context_ack: 'fixture' }, 2);
    expect((await call('command.status', { execution_id: started.execution_id }, 2)).state).toBe('queued');
    // A different request ID arrives late from Run 1, after Run 2 acquired its lease.
    await call('lease.release', {}, 1);
    const current = await call('command.status', { execution_id: started.execution_id }, 2);
    console.log('review stale lease.release result:', JSON.stringify(current));
    expect(current.state).toBe('queued');
    expect(current.stop_confirmed).toBe(false);
  } finally { await node.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
