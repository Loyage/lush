import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RunnerNode } from '../../src/runner/node.js';
import { RunnerClient, LocalTransport } from '../../src/runner/client.js';
import { createCommandService } from '../../src/runner/commands.js';
import { createFileService } from '../../src/runner/files.js';
import { hash } from '../../src/runner/protocol.js';
import { fixtureProcessAdapter } from './fixtures/command-process-adapter.js';

async function until(read, predicate) {
  const deadline = Date.now() + 4000;
  while (true) {
    const result = await read(); if (predicate(result)) return result;
    if (Date.now() >= deadline) throw new Error('integration condition timed out: ' + JSON.stringify(result));
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-command-integrated-'));
  const machine_token = hash('integration-machine'), control_token = hash('integration-control');
  const config = { root, node_id: 'node', machine_token_hash: hash(machine_token),
    projects: { p: { control_token_hash: hash(control_token), enabled: true } }, memory_reserve_bytes: 0 };
  const node = new RunnerNode(config, { refresh_config: () => config });
  const commands = createCommandService({ store: node.store, config: node.config, process_adapter: fixtureProcessAdapter() });
  node.services = { ...commands.services, ...createFileService() }; node.preflight = commands.preflight;
  const client = new RunnerClient({ transport: new LocalTransport(node),
    identity: { project_id: 'p', node_id: 'node', worker_id: 1, workspace_id: 'workspace', generation: 1, operation_id: 'op' },
    auth: { machine_token, control_token } });
  return { node, config, client, async close() { await client.close(); await node.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('merged Client/identity/file-context gates a real command and preserves the shared workspace write barrier', async () => {
  const f = fixture(), client = f.client;
  try {
    const hello = await client.handshake();
    expect(client.identity.runner_id).toBe(hello.runner_id);
    await client.call('workspace.register');
    const rules = await client.call('file.context', { path: 'nested/AGENTS.md' });
    const written = await client.call('file.write', { path: 'nested/AGENTS.md', content: 'NESTED_RULES', expected_sha256: null, context_ack: rules.fingerprint });
    await expect(client.call('command.start', { script: 'touch forbidden', context_ack: rules.fingerprint })).rejects.toMatchObject({ code: 'CONTEXT_REQUIRED' });
    const context = await client.call('file.context', { scope: 'workspace' });
    expect(context.files.map(file => file.path)).toEqual(['nested/AGENTS.md']);
    const command = await client.call('command.start', { script: 'printf READY; sleep 30', context_ack: context.fingerprint });
    await until(() => client.call('command.output', { execution_id: command.execution_id }), page => page.chunks.some(chunk => Buffer.from(chunk.data, 'base64').toString().includes('READY')));
    const fileContext = await client.call('file.context', { path: 'other.txt' });
    await expect(client.call('file.write', { path: 'other.txt', content: 'bad', expected_sha256: null, context_ack: fileContext.fingerprint })).rejects.toMatchObject({ code: 'BUSY' });
    expect((await client.call('command.cancel', { execution_id: command.execution_id })).stop_confirmed).toBe(true);
    const updateContext = await client.call('file.context', { path: 'nested/AGENTS.md' });
    await client.call('file.write', { path: 'nested/AGENTS.md', content: 'CHANGED_RULES', expected_sha256: written.sha256, context_ack: updateContext.fingerprint });
    await expect(client.call('command.start', { script: 'true', context_ack: context.fingerprint })).rejects.toMatchObject({ code: 'CONTEXT_REQUIRED' });
    expect((await client.call('workspace.barrier')).stopped).toBe(true);
  } finally { await f.close(); }
});

test('merged live config revocation stops a running command and refuses subsequent invocation admission', async () => {
  const f = fixture(), client = f.client;
  try {
    await client.handshake(); await client.call('workspace.register');
    const run_token = hash('integration-run');
    await client.call('lease.grant', { run_id: 1, run_token });
    const run = client.forRun({ run_id: 1, run_token });
    const context = await run.call('file.context', { scope: 'workspace' });
    const command = await run.call('command.start', { script: 'printf READY; sleep 30', context_ack: context.fingerprint });
    await until(() => run.call('command.output', { execution_id: command.execution_id }), page => page.chunks.some(chunk => Buffer.from(chunk.data, 'base64').toString().includes('READY')));
    f.config.projects.p.enabled = false;
    f.node.refreshAuthorization();
    const result = await until(() => run.call('command.status', { execution_id: command.execution_id }), value => value.stop_confirmed);
    expect(result.reason).toBe('revoked');
    await expect(run.call('command.start', { script: 'true', context_ack: context.fingerprint })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect((await client.call('workspace.barrier')).stopped).toBe(true);
  } finally { await f.close(); }
});
