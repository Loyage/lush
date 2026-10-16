import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { RunnerClient, LocalTransport } from '../../src/runner/client.js';
import { FrameDecoder, StdioTransport, sshArguments } from '../../src/runner/transport.js';
import { RunnerNode } from '../../src/runner/node.js';
import { hash, LIMITS } from '../../src/runner/protocol.js';
const identity = { project_id: 'project-a', node_id: 'node-a', workspace_id: 'workspace-a', worker_id: 7, generation: 1, operation_id: 'op-a' };
const auth = { machine_token: hash('fixture-machine'), control_token: hash('fixture-control') };
const run_token = hash('fixture-run');
const script = fileURLToPath(new URL('./fixtures/stdio-node.js', import.meta.url));
function remote(root, fault, extra = {}) {
  const transport = new StdioTransport({ command: process.execPath, args: [script, root, ...(fault ? [fault] : [])],
    env: { PATH: '/usr/bin:/bin', HOME: root }, request_ms: 3000 });
  return new RunnerClient({ transport, identity, auth, ...extra });
}
test('independent Runner process: client → protocol → dual authorization → registered workspace → response', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-runner-wire-'));
  const client = remote(root);
  try {
    await expect(client.call('workspace.register')).rejects.toThrow('handshake');
    const hello = await client.handshake();
    expect(hello.node_id).toBe('node-a'); expect(hello.runner_id).toBeTruthy();
    const workspace = await client.call('workspace.register', {}, { request_id: 'registration' });
    expect(fs.statSync(workspace.directory).isDirectory()).toBe(true);
    expect(await client.call('workspace.register', {}, { request_id: 'registration' })).toEqual(workspace);
    await expect(client.call('workspace.register', { path: '/untrusted' }, { request_id: 'registration' })).rejects.toThrow('different parameters');
    const denied = new RunnerClient({ transport: client.transport, identity, auth: { ...auth, control_token: 'not-the-correct-token' } });
    await expect(denied.handshake()).rejects.toThrow('authorization');
    await client.call('lease.grant', { run_id: 8, run_token });
    const run = client.forRun({ run_id: 8, run_token });
    expect((await run.call('workspace.inspect')).generation).toBe(1);
    await run.call('lease.release');
    await expect(run.call('lease.renew')).rejects.toThrow('revoked');
  } finally { await client.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('lost ACK stays unknown; explicit reconnect with pinned installation queries durable result without replay', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-runner-ack-'));
  let first = remote(root, 'drop-register'), second;
  try {
    const hello = await first.handshake();
    await expect(first.call('workspace.register', {}, { request_id: 'one-registration', timeout_ms: 200 })).rejects.toThrow('unknown');
    expect(first.transport.state).toBe('unknown');
    await first.close();
    second = remote(root, null, { expected_runner_id: hello.runner_id });
    expect((await second.handshake()).runner_id).toBe(hello.runner_id);
    const receipt = await second.call('request.status', { request_id: 'one-registration' });
    expect(receipt.state).toBe('completed');
    expect(await second.call('workspace.register', {}, { request_id: 'one-registration' })).toEqual(receipt.result);
    expect(fs.readdirSync(path.join(root, 'workspaces'))).toHaveLength(1);
    const mismatch = new RunnerClient({ transport: second.transport, identity, auth, expected_runner_id: 'different-installation' });
    await expect(mismatch.handshake()).rejects.toThrow('installation');
  } finally { await first.close(); await second?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('frame bounds, split UTF-8 and unfinished frames fail without unbounded buffering', () => {
  const frames = [], decoder = new FrameDecoder(frame => frames.push(frame), 100);
  const data = Buffer.from(JSON.stringify({ value: '中文' }) + '\n');
  for (const byte of data) decoder.push(Buffer.of(byte));
  expect(frames).toEqual([{ value: '中文' }]);
  expect(() => decoder.push(Buffer.alloc(101))).toThrow('limit');
  expect(() => new FrameDecoder(() => {}).push('bad\n')).toThrow('Malformed');
  const partial = new FrameDecoder(() => {}); partial.push('{');
  expect(() => partial.end()).toThrow('incomplete');
});
test('SSH remote startup is constant and destination aliases cannot become options or shell', () => {
  const args = sshArguments('build-node_1');
  expect(args.slice(-3)).toEqual(['--', 'build-node_1', 'lush-runner serve']);
  expect(args).toContain('StrictHostKeyChecking=yes');
  expect(args).toContain('ForwardAgent=no');
  for (const alias of ['-oProxyCommand=x', 'host;touch x', 'user@host', 'a b', 'host\ncommand', '$(id)', '/tmp/host'])
    expect(() => sshArguments(alias)).toThrow('alias');
});
test('local adapter is explicit, shares permission protocol and does not replace local Worker behavior', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-runner-local-'));
  const node = new RunnerNode({ root, node_id: identity.node_id, machine_token_hash: hash(auth.machine_token),
    projects: { 'project-a': { control_token_hash: hash(auth.control_token) } } }, { preflight: async () => {} });
  const client = new RunnerClient({ transport: new LocalTransport(node), identity, auth });
  try {
    await client.handshake();
    expect((await client.call('workspace.register')).worker_id).toBe(7);
    expect((await client.call('workspace.barrier')).stopped).toBe(true);
  } finally { await client.close(); await node.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
