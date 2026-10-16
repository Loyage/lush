import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { RunnerClient, StdioTransport, createRunnerNode, CAPABILITIES } from '../../src/runner/index.js';
import { hash } from '../../src/runner/protocol.js';
const executable = fileURLToPath(new URL('../../bin/lush-runner', import.meta.url));
const fixtureScript = fileURLToPath(new URL('./fixtures/integration-node.js', import.meta.url));
const auth = { machine_token: hash('entry-machine'), control_token: hash('entry-control') };
const identity = { project_id: 'project', node_id: 'node', worker_id: 1, workspace_id: 'workspace', generation: 1, operation_id: 'control-1' };
async function until(read, accept) {
  const deadline = Date.now() + 5000;
  for (;;) { const value = await read(); if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error('Runner integration state deadline');
    await new Promise(resolve => setTimeout(resolve, 15)); }
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-runner-entry-'));
  const local = path.join(root, 'local-control'); fs.mkdirSync(local);
  const config = { version: 1, node_id: 'node', root: path.join(root, 'node'), cgroup_root: path.join(root, 'not-a-cgroup'),
    machine_token_hash: hash(auth.machine_token), projects: { project: { control_token_hash: hash(auth.control_token) } }, memory_reserve_bytes: 0 };
  const config_file = path.join(root, 'node.json'); fs.writeFileSync(config_file, JSON.stringify(config), { mode: 0o600 });
  const clients = [];
  return { root, local, config, config_file,
    connect({ expected_runner_id, drop } = {}) {
      const transport = new StdioTransport({ command: process.execPath, args: [fixtureScript, config_file, ...(drop ? [drop] : [])],
        cwd: local, env: { PATH: '/usr/bin:/bin', HOME: local, OPENAI_API_KEY: 'HOST_SECRET_MUST_NOT_REACH_COMMAND' }, request_ms: 7000 });
      const client = new RunnerClient({ transport, identity, auth, expected_runner_id }); clients.push(client); return client;
    },
    async close() { await Promise.all(clients.map(client => client.close())); fs.rmSync(root, { recursive: true, force: true }); },
  };
}
test('real stdio client → registered permissions → file/image/edit/context → independent command and bounded artifact return', async () => {
  const f = fixture(), client = f.connect();
  try {
    fs.writeFileSync(path.join(f.local, 'same.txt'), 'LOCAL_CONTENT_MUST_NOT_BE_READ');
    expect((await client.handshake()).capabilities.sort()).toEqual([...CAPABILITIES].sort());
    await client.call('workspace.register');
    const write = async (file, content, encoding) => {
      const context = await client.call('file.context', { path: file });
      return client.call('file.write', { path: file, content, encoding, expected_sha256: null, context_ack: context.fingerprint });
    };
    await write('AGENTS.md', 'ROOT_RULES'); await write('nested/AGENTS.md', 'NESTED_RULES');
    const initial = await write('same.txt', 'REMOTE_ORIGINAL\n');
    expect((await client.call('file.read', { path: 'same.txt' })).text).toBe('REMOTE_ORIGINAL\n');
    const context = await client.call('file.context', { path: 'same.txt' });
    await client.call('file.edit', { path: 'same.txt', expected_sha256: initial.sha256, context_ack: context.fingerprint,
      edits: [{ oldText: 'ORIGINAL', newText: 'EDITED' }] });
    expect((await client.call('file.read', { path: 'same.txt' })).text).toBe('REMOTE_EDITED\n');
    expect(fs.readFileSync(path.join(f.local, 'same.txt'), 'utf8')).toBe('LOCAL_CONTENT_MUST_NOT_BE_READ');
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
    const picture = await write('picture.png', png, 'base64');
    expect(await client.call('file.read', { path: 'picture.png' })).toMatchObject({ mime_type: 'image/png', encoding: 'base64', data: png });
    const run_token = hash('entry-run'); await client.call('lease.grant', { run_id: 1, run_token });
    const run = client.forRun({ run_id: 1, run_token });
    const rules = await run.call('file.context', { scope: 'workspace' });
    expect(rules.files.map(file => file.path)).toEqual(['AGENTS.md', 'nested/AGENTS.md']);
    const command = await run.call('command.start', { script: 'test -z "$OPENAI_API_KEY$LUSH_AGENT_TOKEN" || exit 99; printf REMOTE_COMMAND; printf CREATED > command.txt; exit 7', context_ack: rules.fingerprint });
    const stopped = await until(() => run.call('command.status', { execution_id: command.execution_id }), value => value.stop_confirmed);
    expect(stopped.exit_code).toBe(7); expect(stopped.reason).toBe('exit');
    const output = await run.call('command.output', { execution_id: command.execution_id });
    expect(output.complete).toBe(true); expect(output.gap).toBe(false);
    expect(output.chunks.map(chunk => Buffer.from(chunk.data, 'base64').toString()).join('')).toBe('REMOTE_COMMAND');
    expect((await run.call('file.read', { path: 'command.txt' })).text).toBe('CREATED');
    await run.call('lease.release');
    const artifact = await client.call('artifact.register', { artifact_id: 'picture-artifact', path: 'picture.png', sha256: picture.sha256, size: picture.size });
    expect(artifact.sha256).toBe(picture.sha256);
    expect((await client.call('artifact.read', { artifact_id: 'picture-artifact' })).data).toBe(png);
    await expect(client.call('artifact.register', { artifact_id: 'bad-artifact', path: 'picture.png', sha256: hash('wrong'), size: picture.size })).rejects.toMatchObject({ code: 'STALE' });
    expect((await client.call('workspace.barrier')).stopped).toBe(true);
  } finally { await f.close(); }
});
test('lost precise-edit ACK is queried across reconnect, never reapplied to the new content', async () => {
  const f = fixture(); let client = f.connect({ drop: 'fixed-edit' });
  try {
    const hello = await client.handshake(); await client.call('workspace.register');
    const context = await client.call('file.context', { path: 'edit.txt' });
    const original = await client.call('file.write', { path: 'edit.txt', content: 'before', expected_sha256: null, context_ack: context.fingerprint });
    const params = { path: 'edit.txt', expected_sha256: original.sha256, context_ack: context.fingerprint, edits: [{ oldText: 'before', newText: 'after' }] };
    await expect(client.call('file.edit', params, { request_id: 'fixed-edit', timeout_ms: 250 })).rejects.toMatchObject({ code: 'UNKNOWN' });
    await client.close(); client = f.connect({ expected_runner_id: hello.runner_id }); await client.handshake();
    const receipt = await client.call('request.status', { request_id: 'fixed-edit' });
    expect(receipt.state).toBe('completed');
    expect(await client.call('file.edit', params, { request_id: 'fixed-edit' })).toEqual(receipt.result);
    expect((await client.call('file.read', { path: 'edit.txt' })).text).toBe('after');
  } finally { await f.close(); }
});
test('production entry rejects missing real containment and has no test-adapter CLI/environment bypass', async () => {
  const f = fixture();
  try {
    await expect(createRunnerNode(f.config, { process_adapter: { preflight() {} } })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    const child = spawn(process.execPath, [executable, 'serve'], { env: { PATH: '/usr/bin:/bin', HOME: f.local,
      LUSH_RUNNER_CONFIG: f.config_file, LUSH_RUNNER_TEST_ADAPTER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    expect(code).toBe(1); expect(stdout).toBe(''); expect(stderr).toContain('UNSUPPORTED');
    expect(stderr).not.toContain(auth.machine_token); expect(stderr).not.toContain(auth.control_token);
  } finally { await f.close(); }
});
