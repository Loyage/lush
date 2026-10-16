import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RunnerError } from '../../src/runner/protocol.js';
import { RemoteBridgeClient } from '../../src/agent/remote-bridge.js';
import { REMOTE_TOOL_NAMES } from '../../src/agent/remote-contract.js';
import { remoteHarness, write } from './fixtures/remote-harness.js';

const tool = (f, name, args, options) => f.rpc.call('tool', { name, args }, options);
const question = { questions: [{ header: 'Test', question: 'Choose an implementation?', options: [
  { label: 'A', description: 'Option A' }, { label: 'B', description: 'Option B' }] }] };
async function started(f) {
  for (let i = 0; i < 150; i++) {
    if (fs.existsSync(path.join(f.remote, 'started'))) return;
    await delay(10);
  }
  throw new Error('Fixture command did not start');
}

test('Bridge binds current real Store Run/actor and registered tools; rejects management and foreign identities', async () => {
  const f = await remoteHarness();
  try {
    expect((await f.rpc.call('hello')).tools).toEqual(REMOTE_TOOL_NAMES);
    for (const [key, value] of [['worker_id', f.worker.id + 1], ['run_id', f.run.id + 1], ['generation', 2], ['project_id', 'foreign']]) {
      const rpc = new RemoteBridgeClient({ ...f.descriptor, identity: { ...f.descriptor.identity, [key]: value } }, f.token);
      await expect(rpc.call('hello')).rejects.toThrow('Invalid Bridge invocation');
    }
    await expect(new RemoteBridgeClient(f.descriptor, 'wrong-token').call('hello')).rejects.toThrow('Invalid Bridge invocation');
    await expect(f.rpc.call('lease.grant')).rejects.toThrow('not allowlisted');
    await expect(tool(f, 'grep', {})).rejects.toThrow('not registered');
    await expect(tool(f, 'lushc', { argv: ['worker', 'cancel', String(f.worker.id)] })).rejects.toThrow('rejected');
    await expect(tool(f, 'lushc', { argv: ['notice', 'list', '--project', f.root] })).rejects.toThrow('rejected');
    expect((await tool(f, 'lushc', { argv: ['notice', 'list'] })).content[0].text).toBe('[]');
    f.store.update(f.worker.id, { status: 'waiting' });
    await expect(tool(f, 'read', { path: 'same.txt' })).rejects.toThrow('no longer authorized');
    expect(await f.rpc.call('barrier')).toMatchObject({ stopped: true });
  } finally { await f.close(); }
});

test('remote file pages pin content; exact multiple edits, traversal, stale context and no local fallback', async () => {
  const f = await remoteHarness();
  try {
    const context = await f.rpc.call('context');
    write(path.join(f.remote, 'many.txt'), Array.from({ length: 2105 }, (_, i) => `${i + 1}:😀`).join('\n'));
    const first = (await tool(f, 'read', { path: 'many.txt' })).content[0].text;
    expect(first).toContain('2000:😀'); expect(first).not.toContain('2001:😀');
    const metadata = JSON.parse(first.split('\n').at(-1)); expect(metadata.truncated).toBe(true);
    const second = await tool(f, 'read', { path: 'many.txt', offset: 2001, expected_sha256: metadata.sha256 });
    expect(second.content[0].text).toContain('2105:😀');
    write(path.join(f.remote, 'many.txt'), 'changed');
    await expect(tool(f, 'read', { path: 'many.txt', offset: 2001, expected_sha256: metadata.sha256 })).rejects.toThrow('version changed');
    await expect(tool(f, 'read', { path: path.join(f.control, 'same.txt') })).rejects.toThrow('outside');
    await expect(tool(f, 'write', { path: '../escape', content: 'bad', context_ack: context.fingerprint })).rejects.toThrow('Invalid code path');
    fs.symlinkSync(f.control, path.join(f.remote, 'escape'));
    await expect(tool(f, 'read', { path: 'escape/same.txt' })).rejects.toThrow();
    await expect(tool(f, 'write', { path: 'new.txt', content: 'bad' })).rejects.toThrow('current rules');
    write(path.join(f.remote, 'nested/AGENTS.override.md'), 'UPDATED_NESTED_RULES');
    await expect(tool(f, 'write', { path: 'nested/new.txt', content: 'bad', context_ack: context.fingerprint })).rejects.toThrow('current rules');
    expect(fs.existsSync(path.join(f.remote, 'nested/new.txt'))).toBe(false);
    const updated = await f.rpc.call('context');
    await tool(f, 'write', { path: 'nested/new.txt', content: 'a b c', context_ack: updated.fingerprint });
    await expect(tool(f, 'edit', { path: 'nested/new.txt', edits: [{ oldText: 'a b', newText: 'x' }, { oldText: 'b c', newText: 'y' }], context_ack: updated.fingerprint })).rejects.toThrow('overlap');
    expect(fs.readFileSync(path.join(f.remote, 'nested/new.txt'), 'utf8')).toBe('a b c');
    await tool(f, 'edit', { path: 'nested/new.txt', edits: [{ oldText: 'a', newText: 'A' }, { oldText: 'c', newText: 'C' }], context_ack: updated.fingerprint });
    expect(fs.readFileSync(path.join(f.remote, 'nested/new.txt'), 'utf8')).toBe('A b C');
  } finally { await f.close(); }
});

test('allowlisted control resources and real CLI parser/Dispatcher questionnaire never use remote absolute file paths', async () => {
  const f = await remoteHarness();
  try {
    expect((await tool(f, 'control', { action: 'read', id: 'startup', limit: 10 })).content[0].text).toContain('truncated');
    await expect(tool(f, 'control', { action: 'read', id: path.join(f.control, 'startup.json') })).rejects.toThrow('rejected');
    await expect(tool(f, 'control', { action: 'write', id: 'startup', content: '{}' })).rejects.toThrow('rejected');
    await tool(f, 'control', { action: 'write', id: 'questionnaire', content: JSON.stringify(question) });
    expect(fs.existsSync(path.join(f.remote, 'decision.json'))).toBe(false);
    await expect(tool(f, 'lushc', { argv: ['notice', 'check', '--questions-file', path.join(f.remote, 'decision.json')] })).rejects.toThrow('rejected');
    expect((await tool(f, 'lushc', { argv: ['notice', 'check', '--questions-file', 'control:questionnaire'] })).content[0].text).toContain('"valid":true');
    const response = await tool(f, 'lushc', { argv: ['notice', 'post', 'Fixture decision', '--questions-file', 'control:questionnaire'] });
    expect(response.content[0].text).toContain('questionnaire');
    expect(f.store.get('SELECT kind FROM notices WHERE task_id=?', f.worker.id).kind).toBe('questionnaire');
    expect(f.controller.signal.aborted).toBe(true);
    await expect(tool(f, 'read', { path: 'same.txt' })).rejects.toThrow('no longer authorized');
  } finally { await f.close(); }
});

for (const mode of ['cancel', 'node-revoked', 'store-revoked', 'questionnaire']) test(`active command ${mode} waits for real stop and prevents subsequent writes`, async () => {
  const f = await remoteHarness();
  try {
    const context = await f.rpc.call('context'), controller = new AbortController();
    const pending = tool(f, 'bash', { command: 'touch started; while :; do printf x >> activity; sleep 0.02; done', context_ack: context.fingerprint }, { signal: controller.signal });
    const observed = pending.then(value => ({ value }), error => ({ error }));
    await started(f);
    if (mode === 'cancel') controller.abort();
    else if (mode === 'node-revoked') f.settings.save({ nodes: [{ ...f.node, enabled: false }] }, f.settings.read().revision);
    else if (mode === 'questionnaire') {
      await tool(f, 'control', { action: 'write', id: 'questionnaire', content: JSON.stringify(question) });
      const posted = await tool(f, 'lushc', { argv: ['notice', 'post', 'Suspend active remote command', '--questions-file', 'control:questionnaire'] });
      expect(posted.content[0].text).toContain('questionnaire');
      expect(f.controller.signal.aborted).toBe(true); // real Project.notice invalidates Project.actor immediately
      expect(f.store.task(f.worker.id).status).toBe('awaiting');
      await expect(tool(f, 'read', { path: 'same.txt' })).rejects.toThrow('no longer authorized');
    } else f.store.saveRunnerProject({ allowed_node_ids: [], default_node_id: 'local' }, f.store.runnerProject().revision);
    const answer = await observed;
    if (mode === 'cancel') expect(answer.error.message).toContain('stop confirmed');
    else expect(answer.value?.isError || answer.error).toBeTruthy();
    // Same invocation token may stop/reconcile its already-started operation after ordinary authority ends.
    expect(await f.rpc.call('barrier')).toMatchObject({ stopped: true });
    const before = fs.readFileSync(path.join(f.remote, 'activity'), 'utf8');
    await delay(70);
    expect(fs.readFileSync(path.join(f.remote, 'activity'), 'utf8')).toBe(before);
    await expect(tool(f, 'write', { path: 'late', content: 'bad', context_ack: context.fingerprint })).rejects.toThrow();
    expect(fs.existsSync(path.join(f.remote, 'late'))).toBe(false);
  } finally { await f.close(); }
});

test('unknown status never becomes successful delivery; timeout and output gap/truncation are separate', async () => {
  const f = await remoteHarness();
  try {
    const context = await f.rpc.call('context');
    const timed = await tool(f, 'bash', { command: 'sleep 1', timeout: 0.05, context_ack: context.fingerprint });
    expect(timed.isError).toBe(true); expect(timed.content[0].text).toContain('"reason":"timeout"');
    expect(timed.content[0].text).toContain('"stop_confirmed":true');
    const call = f.client.call.bind(f.client); let inject = 'gap';
    f.client.call = async (method, ...args) => {
      if (method === 'command.status' && inject === 'unknown') throw new RunnerError('UNKNOWN', 'Fixture lost status');
      const value = await call(method, ...args);
      return method === 'command.output' && inject === 'gap' ? { ...value, gap: true, truncated: true } : value;
    };
    const gap = await tool(f, 'bash', { command: 'printf output', context_ack: context.fingerprint });
    expect(gap.isError).toBe(true); expect(gap.content[0].text).toContain('"gap":true'); expect(gap.content[0].text).toContain('"truncated":true');
    inject = 'unknown';
    await expect(tool(f, 'bash', { command: 'sleep 1', context_ack: context.fingerprint })).rejects.toThrow('lost status');
    expect(await f.bridge.drain()).toMatchObject({ stopped: false, unknown: true });
  } finally { await f.close(); }
});
