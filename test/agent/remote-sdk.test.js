import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { resolveNativePi } from '../../src/cli/native-pi.js';
import { loadRemotePi, createRemoteSession } from '../../src/agent/remote-sdk.js';
import { REMOTE_TOOL_NAMES } from '../../src/agent/remote-contract.js';
import { forkCheckpoint, readCommitPointer } from '../../src/agent/fork.js';
import { remoteHarness, modelServer, IMAGE, write } from './fixtures/remote-harness.js';

// Explicit real installed SDK: missing/incompatible installation FAILS when opted in. No downloads/accounts.
const realPi = process.env.LUSH_REMOTE_PI_TEST === '1' ? test : test.skip;
async function sessionFor(f, model, extra = {}) {
  const pi = await loadRemotePi(resolveNativePi());
  const modelRuntime = await pi.ModelRuntime.create({ authPath: path.join(f.agentDir, 'auth.json'), modelsPath: null,
    modelsStorePath: path.join(f.agentDir, 'models-cache.json'), refreshOnCreate: false, allowModelNetwork: false });
  modelRuntime.registerProvider('controlled', { api: 'openai-completions', baseUrl: model.url, apiKey: 'fixture-key', models: [{
    id: 'controlled', name: 'Controlled', reasoning: false, input: ['text', 'image'], contextWindow: 64000, maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  return createRemoteSession({ pi, descriptor: f.descriptor, bridge: f.rpc, cwd: f.control, agentDir: f.agentDir,
    modelRuntime, model: modelRuntime.getModel('controlled', 'controlled'), thinkingLevel: 'off',
    settings: { retry: { enabled: false }, compaction: { enabled: false }, images: { autoResize: false } },
    systemPrompt: 'Controlled remote invocation. Read scope rules before modifying code.', sessionDir: f.sessions, sessionId: 'lush-task-fixture', ...extra });
}
realPi('real HTTP model → actual Pi tools → Store-authenticated central Bridge → independent Runner repository', async () => {
  const f = await remoteHarness(); let session;
  const model = modelServer([
    { name: 'read', args: { path: 'same.txt' } },
    { name: 'edit', args: { path: 'same.txt', edits: [{ oldText: 'REMOTE_FIRST', newText: 'REMOTE_EDITED' }, { oldText: 'REMOTE_SECOND', newText: 'SECOND_EDITED' }] } },
    { name: 'write', args: { path: 'nested/new.txt', content: 'REMOTE_NEW' } },
    { name: 'read', args: { path: 'picture.png' } },
    { name: 'bash', args: { command: 'pwd; git rev-parse --show-toplevel; test -z "$LUSH_AGENT_TOKEN$OPENAI_API_KEY"; printf REMOTE_COMMAND' } },
    { name: 'lushc', args: { argv: ['notice', 'list'] } },
    { name: 'lushc', args: { argv: ['skills', 'get', 'progress'] } },
    { name: 'control', args: { action: 'read', id: 'startup' } },
  ]);
  try {
    session = await sessionFor(f, model);
    expect(await session.prompt('Exercise the registered remote tools.')).toBe('remote complete');
    const view = session.inspect();
    expect(view.activeTools.sort()).toEqual([...REMOTE_TOOL_NAMES].sort());
    expect(view.messages.filter(m => m.role === 'toolResult').map(m => m.isError)).toEqual(Array(8).fill(false));
    for (const request of model.requests) expect(request.tools.map(t => t.function.name).sort()).toEqual([...REMOTE_TOOL_NAMES].sort());
    const wire = JSON.stringify(model.requests);
    for (const expected of ['REMOTE_ROOT_RULES', 'REMOTE_NESTED_RULES', 'REMOTE_FIRST', 'REMOTE_COMMAND', 'CONTROL_STARTUP', `data:image/png;base64,${IMAGE}`]) expect(wire).toContain(expected);
    for (const poison of ['LOCAL_POISON', 'LOCAL_CONTEXT_POISON', 'SUPPRESSED_RULES', ...f.secrets]) expect(wire).not.toContain(poison);
    expect(fs.readFileSync(path.join(f.remote, 'same.txt'), 'utf8')).toBe('REMOTE_EDITED\nSECOND_EDITED\n');
    expect(fs.readFileSync(path.join(f.control, 'same.txt'), 'utf8')).toBe('LOCAL_POISON');
    expect(fs.readFileSync(path.join(f.remote, 'nested/new.txt'), 'utf8')).toBe('REMOTE_NEW');
    expect(f.checks()).toBeGreaterThan(15);
    expect(await f.bridge.drain()).toMatchObject({ stopped: true, unknown: false });
  } finally { await session?.close(); model.server.stop(true); await f.close(); }
});

realPi('unknown remote turn barrier cannot create a trusted preemption/checkpoint marker or continue the model', async () => {
  const f = await remoteHarness(); let session;
  const model = modelServer([{ name: 'write', args: { path: 'done.txt', content: 'known write' } }]);
  const previous = process.env.LUSH_RUNTIME_CONTEXT, call = f.client.call.bind(f.client);
  try {
    const preempt = path.join(f.control, 'preempt');
    write(path.join(preempt, `task-${f.worker.id}.request.json`), JSON.stringify({ task_id: f.worker.id, run_id: f.run.id }));
    process.env.LUSH_RUNTIME_CONTEXT = JSON.stringify({ task_id: f.worker.id, run_id: f.run.id, role: 'agent', sessions_dir: f.sessions, preempt_dir: preempt });
    f.client.call = async (method, ...args) => {
      const value = await call(method, ...args);
      return method === 'workspace.barrier' ? { ...value, stopped: false } : value;
    };
    session = await sessionFor(f, model);
    await expect(session.prompt('Exercise unknown turn boundary.')).rejects.toThrow('turn stop remains unknown');
    expect(model.requests).toHaveLength(1);
    expect(fs.existsSync(path.join(preempt, `task-${f.worker.id}.stop.json`))).toBe(false);
    expect(fs.readFileSync(session.inspect().sessionFile, 'utf8')).not.toContain('lush.preempted');
  } finally {
    if (previous === undefined) delete process.env.LUSH_RUNTIME_CONTEXT; else process.env.LUSH_RUNTIME_CONTEXT = previous;
    f.client.call = call; await session?.close(); model.server.stop(true); await f.close();
  }
});

realPi('real SDK resumes local session, forks checkpoint and preserves trusted invocation/usage markers', async () => {
  const f = await remoteHarness(); const model = modelServer([]); let session;
  const previous = process.env.LUSH_RUNTIME_CONTEXT;
  try {
    process.env.LUSH_RUNTIME_CONTEXT = JSON.stringify({ task_id: f.worker.id, run_id: f.run.id, role: 'agent', sessions_dir: f.sessions, soft_budget: { responses: 1 } });
    session = await sessionFor(f, model); await session.prompt('FIRST_CONTEXT_SENTINEL');
    const original = session.inspect().sessionFile;
    const pointer = readCommitPointer(f.control, f.worker.id, f.run.id);
    expect(pointer.session).toBe(original);
    const checkpoint = forkCheckpoint(f.control, { ...pointer, commit: 'b'.repeat(40) });
    await session.close();
    session = await sessionFor(f, model); await session.prompt('SECOND_CONTEXT_SENTINEL');
    expect(session.inspect().sessionFile).toBe(original);
    expect(JSON.stringify(model.requests.at(-1))).toContain('FIRST_CONTEXT_SENTINEL');
    await session.close();
    session = await sessionFor(f, model, { sessionId: 'lush-task-fork', forkFile: checkpoint });
    await session.prompt('THIRD_CONTEXT_SENTINEL');
    expect(session.inspect().sessionFile).not.toBe(original);
    const rows = fs.readFileSync(session.inspect().sessionFile, 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows[0].parentSession).toBe(checkpoint);
    expect(JSON.stringify(model.requests.at(-1))).toContain('FIRST_CONTEXT_SENTINEL');
    expect(JSON.stringify(model.requests.at(-1))).not.toContain('SECOND_CONTEXT_SENTINEL');
    expect(rows.some(r => r.customType === 'lush.invocation' && r.data.run_id === f.run.id)).toBe(true);
    expect(rows.some(r => r.message?.role === 'assistant' && r.message.usage.totalTokens === 30)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(f.sessions, `task-${f.worker.id}-context.json`))).run_id).toBe(f.run.id);
  } finally {
    if (previous === undefined) delete process.env.LUSH_RUNTIME_CONTEXT; else process.env.LUSH_RUNTIME_CONTEXT = previous;
    await session?.close(); model.server.stop(true); await f.close();
  }
});
