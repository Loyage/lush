import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunnerSettings } from '../../src/core/runner-settings.js';
import { RunnerCredentials, validateRunnerControlToken } from '../../src/core/runner-credentials.js';
import { Store } from '../../src/persistence/store.js';
import { RunnerClient, StdioTransport, LIMITS } from '../../src/runner/index.js';
import { hash, validToken } from '../../src/runner/protocol.js';

// Tests the now-committed central contracts against a real stdio Runner with explicit test containment.
// The fixed commit below is fixture metadata, NOT evidence of Git object reception or verification.
test('central settings, private credentials and durable Run identity drive the independent Runner without enlarging node budgets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-runner-central-'));
  const store = new Store(path.join(root, 'central.db'), root);
  let client;
  try {
    const config = { home: path.join(root, 'device') }, settings = new RunnerSettings(config), credentials = new RunnerCredentials(config);
    const saved = settings.save({ nodes: [{ name: 'Fixture', ssh_alias: 'fixture', enabled: true,
      budgets: { max_commands: 64, timeout_ms: 86400000, output_bytes: 64 * 1024 * 1024 } }] }, settings.read().revision);
    const selected = saved.nodes[0];
    const policy = store.saveRunnerProject({ allowed_node_ids: [selected.id], default_node_id: selected.id }, 0).policy;
    const machine_token = 'AB'.repeat(32), control_token = Buffer.alloc(32, 253).toString('base64url');
    credentials.save({ node_id: selected.id, project_id: policy.project_id, machine_token, control_token }, credentials.read().revision);
    const node_file = path.join(root, 'node.json');
    fs.writeFileSync(node_file, JSON.stringify({ version: 1, root: path.join(root, 'remote'), node_id: selected.id,
      machine_token_hash: hash(machine_token), projects: { [policy.project_id]: { control_token_hash: hash(control_token) } },
      cgroup_root: path.join(root, 'test-adapter-only'), budgets: { max_commands: 1, timeout_ms: 1000, output_bytes: 4096 }, memory_reserve_bytes: 0 }), { mode: 0o600 });
    const worker = store.create({ input_id: null, role: 'agent', goal: 'fixture', task_kind: 'order' });
    const transport = new StdioTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/integration-node.js', import.meta.url)), node_file], env: { PATH: '/usr/bin:/bin', HOME: root } });
    let sent;
    const request = transport.request.bind(transport);
    transport.request = (frame, options) => { if (frame.method === 'command.start') sent = structuredClone(frame.params); return request(frame, options); };
    client = new RunnerClient({ transport, identity: { project_id: policy.project_id, node_id: selected.id,
      worker_id: worker.id, workspace_id: 'workspace', generation: 1, operation_id: 'setup' },
      auth: credentials.snapshot(selected.id, policy.project_id), budgets: selected.budgets, expected_runner_id: selected.expected_runner_id });
    expect(client.budgets.timeout_ms).toBe(LIMITS.max_command_ms);
    expect(client.budgets.output_bytes).toBe(LIMITS.output_bytes);
    const hello = await client.handshake();
    settings.save({ nodes: [{ ...selected, expected_runner_id: hello.runner_id }] }, saved.revision);
    const identity = { ...client.identity }; delete identity.operation_id;
    const preparing = store.bindRunnerWorkspace({ ...identity, base_commit: 'a'.repeat(40) });
    await client.call('workspace.register');
    store.confirmRunnerWorkspace(identity, preparing.head_commit, preparing.revision);
    const active = store.update(worker.id, { status: 'running' }), centralRun = store.startRun(active, { agent: 'mock' });
    const runIdentity = { ...identity, run_id: centralRun.id };
    const authorization = store.authorizeRunnerRun(runIdentity, policy.authorization_version);
    const run_token = hash('central-contract-run');
    await client.call('lease.grant', { run_id: centralRun.id, run_token });
    const run = client.forRun({ run_id: centralRun.id, run_token });
    const context = await run.call('file.context', { scope: 'workspace' });
    const started = await run.call('command.start', { script: 'printf compatible', context_ack: context.fingerprint });
    expect(sent.command_ms).toBe(1000); expect(sent.output_bytes).toBe(4096);
    let status; const deadline = Date.now() + 4000;
    do {
      status = await run.call('command.status', { execution_id: started.execution_id });
      if (status.stop_confirmed) break;
      if (Date.now() > deadline) throw new Error(`Runner did not stop: ${JSON.stringify(status)}`);
      await new Promise(resolve => setTimeout(resolve, 15));
    } while (true);
    expect(status.exit_code).toBe(0);
    const output = await run.call('command.output', { execution_id: started.execution_id });
    expect(output.complete).toBe(true);
    expect(output.chunks.map(chunk => Buffer.from(chunk.data, 'base64').toString()).join('')).toBe('compatible');
    const barrier = await run.call('lease.release'); expect(barrier.stopped).toBe(true);
    expect(store.releaseRunnerRun(runIdentity, authorization.revision, { stopped: barrier.stopped }).state).toBe('released');
    expect(store.runnerBinding(worker.id).runner_id).toBe(hello.runner_id);
    expect(store.runnerBarriers(worker.id)).toEqual({ bindings: [], runs: [], receipts: [] });
    expect(JSON.stringify(settings.read())).not.toContain(machine_token);
    expect(JSON.stringify(credentials.read())).not.toContain(control_token);
  } finally { await client?.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('central and Runner credential validators agree on encoding boundaries without normalizing token bytes', () => {
  for (const token of ['AB'.repeat(32), 'a'.repeat(256), Buffer.alloc(32, 255).toString('base64url'),
    Buffer.alloc(31).toString('base64url'), 'a'.repeat(32), 'a'.repeat(257), 'x'.repeat(43), 'abc=', '', null]) {
    let accepted = true;
    try { validateRunnerControlToken(token); } catch { accepted = false; }
    expect(validToken(token)).toBe(accepted);
  }
  expect(hash('AB'.repeat(32))).not.toBe(hash('ab'.repeat(32)));
});
