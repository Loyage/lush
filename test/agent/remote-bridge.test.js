import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { REMOTE_TOOL_NAMES } from '../../src/agent/remote-contract.js';
import { remoteHarness } from './fixtures/remote-harness.js';

const tool = (f, name, args) => f.rpc.call('tool', { name, args });

test('registered remote Bridge tools read, write, edit, execute and post a questionnaire through the real Dispatcher', async () => {
  const f = await remoteHarness();
  try {
    expect((await f.rpc.call('hello')).tools).toEqual(REMOTE_TOOL_NAMES);
    const context = await f.rpc.call('context');
    expect((await tool(f, 'read', { path: 'same.txt' })).content[0].text).toContain('REMOTE_FIRST');
    await tool(f, 'write', { path: 'nested/new.txt', content: 'a b c', context_ack: context.fingerprint });
    await tool(f, 'edit', { path: 'nested/new.txt', edits: [{ oldText: 'a', newText: 'A' }, { oldText: 'c', newText: 'C' }], context_ack: context.fingerprint });
    expect(fs.readFileSync(path.join(f.remote, 'nested/new.txt'), 'utf8')).toBe('A b C');
    expect(fs.readFileSync(path.join(f.control, 'same.txt'), 'utf8')).toBe('LOCAL_POISON');
    const command = await tool(f, 'bash', { command: 'cat nested/new.txt', context_ack: context.fingerprint });
    expect(command.isError).not.toBe(true); expect(command.content[0].text).toContain('A b C');
    expect((await tool(f, 'lushc', { argv: ['notice', 'list'] })).content[0].text).toBe('[]');
    expect((await tool(f, 'control', { action: 'read', id: 'startup' })).content[0].text).toContain('CONTROL_STARTUP');
    await tool(f, 'control', { action: 'write', id: 'questionnaire', content: JSON.stringify({ questions: [{
      header: 'Test', question: 'Choose an implementation?', options: [
        { label: 'A', description: 'Option A' }, { label: 'B', description: 'Option B' }],
    }] }) });
    const response = await tool(f, 'lushc', { argv: ['notice', 'post', 'Fixture decision', '--questions-file', 'control:questionnaire'] });
    expect(response.content[0].text).toContain('questionnaire');
    expect(f.store.get('SELECT kind FROM notices WHERE task_id=?', f.worker.id).kind).toBe('questionnaire');
    expect(f.controller.signal.aborted).toBe(true);
    expect(await f.rpc.call('barrier')).toMatchObject({ stopped: true });
  } finally { await f.close(); }
});
