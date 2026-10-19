import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const RPC_HELPER = fileURLToPath(new URL('../../src/agent/management-rpc.js', import.meta.url));

/** Model-free CLI stand-in. Only Pi's registration/event/selection API is controlled;
 * extensions, execute functions, Provider arguments and the Bun RPC bridge are real.
 * The plan contains test inputs, never a second production tool catalogue.
 */
// Catalogues carry the complete schemas. Verify their text/details parity in the
// controlled CLI by default, then return only one copy to the Provider result.
export function managementToolCLI(root, runtime, { compactCatalog = true, compatibilityRPCPlans = false } = {}) {
  const command = path.join(root, 'controlled-pi');
  const planFile = path.join(root, 'tool-plan.json');
  fs.writeFileSync(command, `#!/usr/bin/env ${runtime}
import fs from 'node:fs';
import cp from 'node:child_process';
const args = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(${JSON.stringify(planFile)}, 'utf8'));
const input = JSON.parse(fs.readFileSync(args.find(arg => arg.startsWith('@')).slice(1), 'utf8'));
if (input.task.role !== 'manager' || input.task.task_kind !== 'management') throw Error('not a management invocation');
const builtins = ['read', 'bash', 'write', 'edit', 'mcp__shell__exec'];
const tools = new Map(builtins.map(name => [name, { name }]));
const handlers = new Map(), entries = [];
let active = [...builtins];
const pi = {
  registerTool(tool) { if (tools.has(tool.name)) throw Error('duplicate tool'); tools.set(tool.name, tool); },
  on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
  setActiveTools(names) { active = names.filter(name => tools.has(name)); },
  getActiveTools() { return [...active]; },
  appendEntry(type, data) { entries.push({ type, data }); },
};
const ctx = { sessionManager: { getLeafEntry: () => null, getLeafId: () => null, getSessionFile: () => null } };
async function emit(name, event = {}) {
  const results = [];
  for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
  return results;
}
const extensions = args.filter((_, i) => args[i - 1] === '--extension');
for (const extension of extensions) (await import(extension)).default(pi);
const registered = [...tools.keys()].filter(name => !builtins.includes(name));
const selection = args.indexOf('--tools');
if (selection < 0) throw Error('Provider omitted tool selection');
pi.setActiveTools(args[selection + 1].split(','));
const cliActive = pi.getActiveTools();
await emit('session_start');
const sessionActive = pi.getActiveTools();
// Simulate a resumed session trying to re-enable ambient/nested tools.
pi.setActiveTools([...active, ...builtins]);
await emit('before_agent_start', { systemPrompt: 'untrusted resumed overlay' });
const modelActive = pi.getActiveTools();
const blocked = [];
for (const toolName of builtins) blocked.push((await emit('tool_call', { toolName, parentToolCallId: 'nested' })).some(r => r?.block));
const replies = [];
// Explicit compatibility-only probes are not registered/active model tools. They
// exercise retained internal RPC/receipts; the new CLI suite never enables this.
async function compatibilityRPC(method, params) {
  const child = cp.spawnSync(process.env.LUSH_MANAGER_BUN, [${JSON.stringify(RPC_HELPER)}], {
    env: process.env, input: JSON.stringify({ method, params }), encoding: 'utf8', maxBuffer: 256 * 1024,
  });
  let value; try { value = JSON.parse(child.stdout); } catch { throw Error('管理请求被拒绝或未确认完成'); }
  if (child.status !== 0) throw Error(value.diagnostic || value.kind ? JSON.stringify(value) : '管理请求被拒绝或未确认完成；可用 CLI help 核对用法');
  return value.result;
}
async function compatibilityProbe(name, params, callId) {
  let method = name.replace('_', '.'), body = params;
  if (['manager_query','manager_start','manager_retry'].includes(name)) {
    let id = params.worker;
    if (typeof id === 'string') id = (await compatibilityRPC('worker.lookup', { number: id })).id;
    body = id === undefined ? {} : { id };
  } else if (name === 'manager_call') body = { ...params, request_id: params.request_id ?? callId ?? 'probe-' + name };
  const details = await compatibilityRPC(method, body);
  return { details, content: [{ type: 'text', text: JSON.stringify(details) }] };
}
for (const [planIndex, { name, params, callId }] of plan.entries()) {
  // Registration/activation failures are not capability-denial results.
  const legacy = ${JSON.stringify(compatibilityRPCPlans)} && name.startsWith('manager_');
  if (!legacy && (!active.includes(name) || !tools.get(name)?.execute)) throw Error('tool not registered/active: ' + name);
  if (!legacy && (await emit('tool_call', { toolName: name })).some(r => r?.block)) throw Error('management tool blocked: ' + name);
  try {
    const response = legacy ? await compatibilityProbe(name, params, callId)
      : await tools.get(name).execute(callId ?? 'probe-' + name + '-' + planIndex, params, new AbortController().signal, ctx);
    // The real tool returns the full catalogue twice (text and details). Verify
    // both inside the child, but do not echo both into the final Provider result:
    // combined catalogues otherwise exceed the unchanged 256000-byte result cap.
    if (${JSON.stringify(compactCatalog)} && name === 'manager_catalog') {
      if (JSON.stringify(response.content) !== JSON.stringify([{ type: 'text', text: JSON.stringify(response.details) }]))
        throw Error('catalogue text/details mismatch');
      replies.push({ name, response: { ...response, content: [] }, catalogContentVerified: true });
    } else replies.push({ name, response });
  } catch (error) { replies.push({ name, error: error.message }); }
}
console.log(JSON.stringify({ runtime: typeof Bun === 'undefined' ? 'node' : 'bun', extensions,
  registered, cliActive, sessionActive, modelActive, blocked, entries, replies }));
`, { mode: 0o755 });
  return { command, plan(steps) { fs.writeFileSync(planFile, JSON.stringify(steps), { mode: 0o600 }); } };
}
