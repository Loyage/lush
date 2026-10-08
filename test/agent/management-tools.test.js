import { test, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { temp } from '../helpers.js';
import { registerManagementTools, managementRPCRequest, MANAGEMENT_TOOL_NAMES } from '../../src/agent/pi-management.js';
import { managementInvocation, validateManagementRPC } from '../../src/agent/management-rpc.js';

function invocation(root) {
  return { PATH: process.env.PATH, LUSH_PROJECT: root, LUSH_HOME: path.join(root, '.lush'), LUSH_TASK_ID: '50',
    LUSH_AGENT_TOKEN: 'invocation-token', LUSH_RUNTIME_CONTEXT: JSON.stringify({ role: 'manager', task_kind: 'management', task_id: 50, run_id: 12 }),
    LUSH_MANAGER_RPC_SOCKET: path.join(root, 'rpc.sock'), LUSH_MANAGER_BUN: process.execPath };
}
function harness(env, request) {
  const tools = new Map(), handlers = new Map(); let active = ['bash', 'write', 'codemode', 'mcp__shell__exec'];
  registerManagementTools({ registerTool(tool) { tools.set(tool.name, tool); }, on(name, handler) { handlers.set(name, handler); },
    setActiveTools(names) { active = names; } }, request, env);
  return { tools, handlers, active: () => active };
}

function server(root, handle) {
  return Bun.listen({ unix: path.join(root, 'rpc.sock'), socket: {
    data(socket, data) {
      const request = JSON.parse(Buffer.from(data).toString());
      const response = handle(request);
      if (response) socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response }) + '\n');
    },
  } });
}

test('the management extension registers only three model-only tools and blocks all other tools including resumed/nested calls', () => {
  const root = temp();
  try {
    const f = harness(invocation(root), async () => ({}));
    expect([...f.tools.keys()]).toEqual([...MANAGEMENT_TOOL_NAMES]);
    f.handlers.get('session_start')(); expect(f.active()).toEqual([...MANAGEMENT_TOOL_NAMES]);
    const forced = f.handlers.get('before_agent_start')({ systemPrompt: 'GLOBAL APPEND: USE BASH', systemPromptOptions: {} });
    expect(f.active()).toEqual([...MANAGEMENT_TOOL_NAMES]);
    expect(forced.systemPrompt).toContain('专用管理型 Agent');
    expect(forced.systemPrompt).not.toContain('GLOBAL APPEND');
    for (const tool of f.tools.values()) {
      expect(tool.exposure).toBe('model-only'); expect(tool.parameters.additionalProperties).toBe(false);
      expect(tool.annotations.openWorldHint).toBe(false);
      expect(f.handlers.get('tool_call')({ toolName: tool.name })).toBeUndefined();
    }
    for (const name of ['read', 'bash', 'write', 'edit', 'ls', 'codemode', 'mcp__shell__exec', 'worker_retry'])
      expect(f.handlers.get('tool_call')({ toolName: name, parentToolCallId: 'nested' }).block).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('trusted tools resolve real W numbers and call only the bound manager methods without arbitrary RPC/profile/token parameters', async () => {
  const root = temp(), calls = [], values = invocation(root);
  const f = harness(values, async (method, params, _signal, bound) => {
    calls.push({ method, params, token: bound.LUSH_AGENT_TOKEN });
    return method === 'worker.lookup' ? { id: 99, worker_number: params.number } : { status: 'waiting', target_id: params.id, receipt_id: 'r1' };
  });
  try {
    values.LUSH_AGENT_TOKEN = 'later-token'; // A stale extension cannot adopt a later invocation.
    const result = await f.tools.get('manager_start').execute('call', { worker: 'W117-1' }, new AbortController().signal);
    expect(result.details).toMatchObject({ status: 'waiting', target_id: 99 });
    expect(JSON.parse(result.content[0].text)).toEqual(result.details);
    await f.tools.get('manager_retry').execute('call', { worker: 7 });
    await f.tools.get('manager_query').execute('call', {});
    expect(calls).toEqual([
      { method: 'worker.lookup', params: { number: 'W117-1' }, token: 'invocation-token' },
      { method: 'manager.start', params: { id: 99 }, token: 'invocation-token' },
      { method: 'manager.retry', params: { id: 7 }, token: 'invocation-token' },
      { method: 'manager.query', params: {}, token: 'invocation-token' },
    ]);
    for (const params of [{ worker: 'W0' }, { worker: 'W1; rm -rf /' }, { worker: '99' }, { worker: -1 }, { worker: 1.2 },
      { worker: 1, method: 'worker.cancel' }, { worker: 1, profile: { agent: 'codex' } }, { worker: 1, _token: 'user' }, {}])
      await expect(f.tools.get('manager_start').execute('bad', params)).rejects.toThrow();
    expect(calls.length).toBe(4);
    expect(JSON.stringify(result)).not.toContain('invocation-token');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cancellation after Worker lookup prevents a later start request even with a custom transport', async () => {
  const root = temp(), controller = new AbortController(), calls = [];
  try {
    const f = harness(invocation(root), async method => {
      calls.push(method); controller.abort(); return { id: 99, worker_number: 'W117' };
    });
    await expect(f.tools.get('manager_start').execute('start', { worker: 'W117' }, controller.signal)).rejects.toThrow('未确认完成');
    expect(calls).toEqual(['worker.lookup']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('missing tokens, stale/mismatched role or project bindings fail closed before any RPC call', async () => {
  const root = temp(); let called = 0;
  try {
    for (const patch of [{ LUSH_AGENT_TOKEN: '' }, { LUSH_AGENT_TOKEN: undefined }, { LUSH_TASK_ID: '51' },
      { LUSH_HOME: '/another-project/.lush' }, { LUSH_PROJECT: '' }, { LUSH_MANAGER_RPC_SOCKET: 'relative.sock' },
      { LUSH_RUNTIME_CONTEXT: 'invalid JSON' }, { LUSH_RUNTIME_CONTEXT: JSON.stringify({ role: 'agent', task_kind: 'order', task_id: 50, run_id: 12 }) },
      { LUSH_RUNTIME_CONTEXT: JSON.stringify({ role: 'manager', task_kind: 'management', task_id: 50 }) }]) {
      const f = harness({ ...invocation(root), ...patch }, async () => { called++; return {}; });
      await expect(f.tools.get('manager_query').execute('query', {})).rejects.toThrow();
    }
    expect(called).toBe(0);
    for (const method of ['worker.retry', 'worker.resume', 'order.submit', 'worker.cancel', 'agent.configure', 'system.stop'])
      expect(() => validateManagementRPC(method, { id: 1 })).toThrow('unsupported');
    expect(() => validateManagementRPC('manager.start', { id: 1, _token: '' })).toThrow('target');
    expect(() => validateManagementRPC('manager.query', { profile: {} })).toThrow('target');
    expect(() => managementInvocation({})).toThrow('invocation');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the Node-compatible extension calls the project RPCClient through a fixed Bun bridge and always sends its invocation token', async () => {
  const root = temp(), calls = [], values = invocation(root);
  const listener = server(root, request => {
    calls.push(request);
    return { result: request.method === 'worker.lookup' ? { id: 99, worker_number: 'W117-1' }
      : { status: 'succeeded', target_id: request.params.id, target_worker_number: 'W117-1', receipt_id: 'r1' } };
  });
  try {
    const f = harness(values, managementRPCRequest);
    const result = await f.tools.get('manager_retry').execute('retry', { worker: 'W117-1' }, new AbortController().signal);
    expect(result.details.status).toBe('succeeded');
    expect(calls.map(item => [item.method, item.params])).toEqual([
      ['worker.lookup', { number: 'W117-1', _token: 'invocation-token' }], ['manager.retry', { id: 99, _token: 'invocation-token' }],
    ]);
    expect(JSON.stringify(result)).not.toContain('invocation-token');
  } finally { listener.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
});

test('real Node execution of the Pi extension reaches the trusted Bun RPC bridge without a Bun global in Node', async () => {
  const root = temp(), values = invocation(root); let calls = 0;
  const listener = server(root, request => {
    expect(request.method).toBe('manager.query'); expect(request.params._token).toBe('invocation-token'); calls++;
    return { result: { workers: [{ id: 99, status: 'paused' }] } };
  });
  try {
    const extension = fileURLToPath(new URL('../../src/agent/pi-management.js', import.meta.url));
    const program = `import {managementRPCRequest} from ${JSON.stringify(extension)};
      if (typeof Bun !== 'undefined') throw Error('not running in Node');
      console.log(JSON.stringify(await managementRPCRequest('manager.query',{},undefined,process.env)));`;
    const output = await new Promise((resolve, reject) => cp.execFile('node', ['--input-type=module', '-e', program],
      { env: values, timeout: 30000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    expect(JSON.parse(output)).toEqual({ workers: [{ id: 99, status: 'paused' }] }); expect(calls).toBe(1);
  } finally { listener.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
});

test('expired invocation tokens and arbitrary daemon errors never retry or downgrade to user identity and never leak diagnostics', async () => {
  const root = temp(), calls = [], values = invocation(root);
  const listener = server(root, request => {
    calls.push(request); return { error: { code: -32009, message: 'EXPIRED SECRET invocation-token FIXTURE-CREDENTIAL' } };
  });
  try {
    const f = harness(values, managementRPCRequest);
    let error;
    try { await f.tools.get('manager_start').execute('start', { worker: 99 }); } catch (caught) { error = caught; }
    expect(error.message).toContain('未确认完成');
    for (const secret of ['invocation-token', 'FIXTURE-CREDENTIAL', 'EXPIRED SECRET']) expect(error.message).not.toContain(secret);
    expect(calls.length).toBe(1); expect(calls[0].params._token).toBe('invocation-token');
  } finally { listener.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
});

test('cancelling a dispatched management request kills its bridge but reports unknown effect rather than claiming rollback', async () => {
  const root = temp(), values = invocation(root), controller = new AbortController(); let dispatched = 0;
  const listener = server(root, () => { dispatched++; controller.abort(); return null; });
  let bridge, closed = false;
  const spawn = cp.spawn;
  const capture = spyOn(cp, 'spawn').mockImplementation((...args) => {
    bridge = spawn(...args); bridge.once('close', () => { closed = true; }); return bridge;
  });
  try {
    const request = managementRPCRequest('manager.start', { id: 99 }, controller.signal, values);
    capture.mockRestore(); // Capture only this synchronous spawn, never another concurrent test's process.
    await expect(request).rejects.toThrow('副作用可能已经发生');
    expect(dispatched).toBe(1);
    expect(closed).toBe(true);
    expect(() => process.kill(bridge.pid, 0)).toThrow();
    await expect(managementRPCRequest('manager.start', { id: 99 }, controller.signal, values)).rejects.toThrow();
    expect(dispatched).toBe(1);
  } finally { capture.mockRestore(); listener.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
});
