import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { RunnerBridge } from './bridge.js';
import { createControlledSession } from './controlled-session.js';
import { TOOL_NAMES, CONTROLLED_CONFIGURATION, assertSupportedConfiguration } from './registry.js';

const [entry, scenario] = process.argv.slice(2);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-remote-feasibility-'));
const control = path.join(directory, 'control');
const remote = path.join(directory, 'runner-repository');
const home = path.join(directory, 'runner-home');
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = file => fs.readFileSync(file, 'utf8');
const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8',
  env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
const binding = { project: 'fixture-project', worker: 1, run: 1, generation: 1, token: randomUUID() };
// Valid 1x1 RGBA PNG (including chunk CRCs), not merely a PNG signature.
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
let bridge, session, server;
const requests = [];
const events = [];
function modelServer(script) {
  let step = 0;
  return Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    assert.equal(new URL(request.url).pathname, '/v1/chat/completions');
    const body = await request.json(); requests.push(body);
    const action = script[step++];
    const delta = action ? { tool_calls: [{ index: 0, id: `call_${step}`, type: 'function',
      function: { name: action.name, arguments: JSON.stringify(action.args) } }] } : { content: 'fixture complete' };
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: `response_${step}`,
      object: 'chat.completion.chunk', created: 1, model: 'controlled',
      choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(chunk({ role: 'assistant' }) + chunk(delta)
      + chunk({}, action ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
  } });
}
function isRunning(pid) {
  try {
    // Linux zombies cannot write; fixture is explicitly Linux-only.
    return !/\) Z /.test(read(`/proc/${pid}/stat`));
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function checkModelTools() {
  assert.ok(requests.length > 0);
  for (const request of requests) assert.deepEqual(request.tools.map(tool => tool.function.name).sort(), [...TOOL_NAMES].sort());
}
function runtimeContext(run) {
  return { task_id: 1, run_id: run, role: 'agent', task_kind: 'child', config_mode: 'lush',
    sessions_dir: path.join(control, 'sessions'), preempt_dir: path.join(control, 'preempt') };
}
async function setup(script, { trustedRuntime = false } = {}) {
  for (const dir of [control, remote, home]) fs.mkdirSync(dir);
  for (const dir of [control, remote]) {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.name', 'Fixture'); git(dir, 'config', 'user.email', 'fixture@invalid');
    write(path.join(dir, 'same.txt'), dir === control ? 'LOCAL_SAME_MUST_NOT_APPEAR\n' : 'REMOTE_ORIGINAL\n');
    write(path.join(dir, 'AGENTS.md'), dir === control ? 'LOCAL_CONTEXT_MUST_NOT_APPEAR' : 'REMOTE_ROOT_CONTEXT');
    write(path.join(dir, '.pi/extensions/poison.js'), `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(path.join(dir, 'DISCOVERY_EXECUTED'))}, 'bad');\nexport default function () { throw new Error('DISCOVERY_EXECUTED'); }`);
    write(path.join(dir, '.pi/SYSTEM.md'), 'POISON_SYSTEM');
    write(path.join(dir, '.pi/prompts/poison.md'), 'POISON_TEMPLATE');
    write(path.join(dir, '.pi/skills/poison/SKILL.md'), '---\nname: poison\ndescription: POISON_SKILL\n---\nsecret');
    write(path.join(dir, '.pi/mcp.json'), JSON.stringify({ mcpServers: { poison: { command: '/must-not-start' } } }));
    write(path.join(dir, '.pi/settings.json'), JSON.stringify({ packages: ['npm:must-not-install'], defaultTools: ['powershell'] }));
    git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'independent fixture repository');
  }
  write(path.join(control, 'only-local.txt'), 'LOCAL_FALLBACK_MUST_NOT_APPEAR');
  write(path.join(control, 'picture.png'), 'not a remote image');
  write(path.join(control, 'startup.json'), '{"control":"LOCAL_CONTROL_FILE"}');
  write(path.join(remote, 'picture.png'), Buffer.from(image, 'base64'));
  write(path.join(remote, 'nested/AGENTS.md'), 'NESTED_SUPPRESSED');
  write(path.join(remote, 'nested/AGENTS.override.md'), 'REMOTE_NESTED_OVERRIDE');
  fs.symlinkSync(control, path.join(remote, 'escape'));
  assertSupportedConfiguration(CONTROLLED_CONFIGURATION);
  bridge = new RunnerBridge({ entry, root: remote, home, binding });
  server = modelServer(script);
  session = await createControlledSession({ entry, config: CONTROLLED_CONFIGURATION, bridge,
    controlDir: control, modelUrl: `http://127.0.0.1:${server.port}/v1`,
    ...(trustedRuntime ? { runtimeContext: runtimeContext(1) } : {}) });
  session.subscribe(event => events.push(event));
  assert.deepEqual(session.activeTools.sort(), [...TOOL_NAMES].sort());
  assert.notEqual(session.remote.pid, process.pid);
  assert.equal(session.remote.root, remote);
  assert.equal(session.remote.version, session.version);
}
async function routing() {
  const script = [
    { name: 'read', args: { path: 'same.txt' } },
    { name: 'edit', args: { path: 'same.txt', edits: [{ oldText: 'REMOTE_ORIGINAL', newText: 'REMOTE_EDITED' }] } },
    { name: 'write', args: { path: 'nested/new.txt', content: 'REMOTE_WRITTEN' } },
    { name: 'read', args: { path: 'picture.png' } },
    { name: 'bash', args: { command: 'pwd; git rev-parse --show-toplevel; printf "REMOTE_SHELL\\n"; test -z "$LUSH_AGENT_TOKEN$OPENAI_API_KEY$PI_SESSION_FILE"; printf "ENV_CLEAN=%s\\n" "$?"; printf "BASH_WRITE" > shell.txt' } },
    { name: 'read', args: { path: 'only-local.txt' } },
    { name: 'read', args: { path: path.join(control, 'startup.json') } },
    { name: 'write', args: { path: '../control/denied.txt', content: 'bad' } },
    { name: 'read', args: { path: 'escape/same.txt' } },
    { name: 'edit', args: { path: 'same.txt', edits: [{ oldText: 'WRONG_PRECONDITION', newText: 'bad' }] } },
    // Even a misbehaving model cannot call a built-in left out of the active set.
    { name: 'grep', args: { pattern: 'LOCAL', path: control } },
  ];
  await setup(script);
  await session.prompt('Exercise remote code tools; startup control files are not code paths.');
  checkModelTools();
  assert.equal(requests.length, script.length + 1);
  const snapshot = session.inspect();
  const results = snapshot.messages.filter(message => message.role === 'toolResult');
  assert.equal(results.length, script.length);
  assert.deepEqual(results.map(message => message.isError), [false, false, false, false, false, true, true, true, true, true, true]);
  assert.ok(results[0].content.some(part => part.text?.includes('REMOTE_ORIGINAL')));
  const picture = results[3].content.find(part => part.type === 'image');
  assert.equal(picture?.mimeType, 'image/png');
  assert.equal(picture.data, image);
  const wire = JSON.stringify(requests);
  assert.ok(wire.includes('data:image/png;base64,' + image));
  assert.ok(wire.includes('REMOTE_ROOT_CONTEXT'));
  assert.ok(wire.includes('REMOTE_NESTED_OVERRIDE'));
  assert.ok(wire.includes('REMOTE_SHELL'));
  assert.ok(wire.includes('ENV_CLEAN=0'));
  for (const poison of ['LOCAL_SAME_MUST_NOT_APPEAR', 'LOCAL_CONTEXT_MUST_NOT_APPEAR', 'LOCAL_FALLBACK_MUST_NOT_APPEAR',
    'LOCAL_CONTROL_FILE', 'POISON_SYSTEM', 'POISON_TEMPLATE', 'POISON_SKILL', 'NESTED_SUPPRESSED', binding.token]) {
    assert.ok(!wire.includes(poison), poison);
  }
  assert.equal(read(path.join(remote, 'same.txt')), 'REMOTE_EDITED\n');
  assert.equal(read(path.join(control, 'same.txt')), 'LOCAL_SAME_MUST_NOT_APPEAR\n');
  assert.equal(read(path.join(remote, 'nested/new.txt')), 'REMOTE_WRITTEN');
  assert.equal(read(path.join(remote, 'shell.txt')), 'BASH_WRITE');
  for (const file of ['nested/new.txt', 'shell.txt', 'denied.txt']) assert.equal(fs.existsSync(path.join(control, file)), false);
  assert.ok(snapshot.sessionFile.startsWith(path.join(control, 'sessions') + path.sep));
  assert.ok(read(snapshot.sessionFile).includes('REMOTE_EDITED'));
  assert.equal(fs.existsSync(path.join(remote, 'sessions')), false);
  for (const dir of [control, remote]) assert.equal(fs.existsSync(path.join(dir, 'DISCOVERY_EXECUTED')), false);
  assert.notEqual(git(control, 'rev-parse', '--git-dir') && fs.realpathSync(path.join(control, '.git')), fs.realpathSync(path.join(remote, '.git')));
  assert.equal(git(control, 'diff', '--exit-code'), '');
  const before = bridge.audit.filter(event => event.event === 'admitted').length;
  for (const key of ['project', 'worker', 'run', 'generation', 'token']) {
    await assert.rejects(bridge.send({ ...binding, [key]: 'wrong', id: randomUUID(), method: 'tool', name: 'write',
      args: { path: 'unauthorized.txt', content: 'bad' } }), /Denied: invocation binding/);
  }
  await assert.rejects(bridge.call('tool', { name: 'grep', args: {} }), /not registered/);
  await assert.rejects(bridge.send({ ...binding, id: randomUUID(), method: 'tool', name: 'grep', args: {} }), /not registered/);
  assert.equal(bridge.audit.filter(event => event.event === 'admitted').length, before);
  assert.equal(fs.existsSync(path.join(remote, 'unauthorized.txt')), false);
  const fixedRequest = { ...binding, id: randomUUID(), method: 'tool', name: 'write',
    args: { path: 'once.txt', content: 'ONCE' } };
  await bridge.send(fixedRequest);
  await assert.rejects(bridge.send(fixedRequest), /Duplicate request refused/);
  assert.equal(read(path.join(remote, 'once.txt')), 'ONCE');
  assert.deepEqual([...new Set(bridge.audit.filter(event => event.event === 'admitted').map(event => event.tool))].sort(), [...TOOL_NAMES].sort());
}
async function cancellation() {
  await setup([{ name: 'bash', args: { command: 'sleep 30 & printf "%s" "$!" > descendant.pid; echo READY; wait' } }]);
  const ready = Promise.withResolvers();
  session.subscribe(event => {
    if (event.type === 'tool_execution_update' && JSON.stringify(event.partialResult).includes('READY')) ready.resolve();
  });
  const prompting = session.prompt('Run the controlled cancellable command.');
  await ready.promise;
  const descendant = Number(read(path.join(remote, 'descendant.pid')));
  assert.ok(isRunning(descendant));
  await session.abort(); await prompting;
  assert.equal(isRunning(descendant), false);
  const started = bridge.audit.find(event => event.event === 'command_started');
  const stopped = bridge.audit.find(event => event.event === 'command_stopped' && event.id === started.id);
  assert.ok(stopped);
  assert.equal(isRunning(started.pid), false);
  assert.equal(bridge.pending.size, 0);
  assert.ok(events.some(event => event.type === 'tool_execution_end' && event.isError));
  checkModelTools();
  // A returned shell must not leave same-group background writers running either.
  await bridge.call('tool', { name: 'bash', args: { command: 'sleep 30 </dev/null >/dev/null 2>&1 & echo $! > background.pid' } });
  assert.equal(isRunning(Number(read(path.join(remote, 'background.pid')))), false);
  // Abort queued before admission must not even send a new Runner request.
  const abort = new AbortController(); abort.abort();
  await assert.rejects(bridge.call('tool', { name: 'write', args: { path: 'cancelled.txt', content: 'bad' } }, { signal: abort.signal }), /before admission/);
  assert.equal(fs.existsSync(path.join(remote, 'cancelled.txt')), false);
  await assert.rejects(bridge.call('tool', { name: 'bash', args: { command: 'sleep 30', timeout: 0.05 } }), /timed out|timeout/i);
  const latest = bridge.audit.filter(event => event.event === 'command_started').at(-1);
  assert.ok(bridge.audit.some(event => event.event === 'command_stopped' && event.id === latest.id));
  assert.equal(isRunning(latest.pid), false);
}
async function disconnect() {
  await setup([]);
  const ready = Promise.withResolvers();
  const execution = bridge.call('tool', { name: 'bash', args: { command: 'sleep 30 & echo $! > lost.pid; echo READY; wait' } },
    { onUpdate: result => { if (JSON.stringify(result).includes('READY')) ready.resolve(); } });
  // Attach immediately: the fault is an expected rejection, not an unhandled promise.
  const rejected = assert.rejects(execution, /unknown|aborted/);
  await ready.promise;
  const pid = Number(read(path.join(remote, 'lost.pid')));
  bridge.child.stdin.end(); // Node-side EOF watchdog, no automatic retry or replacement.
  await rejected; await bridge.exit;
  assert.equal(bridge.state, 'unknown');
  assert.equal(isRunning(pid), false);
  await assert.rejects(bridge.call('tool', { name: 'write', args: { path: 'after-loss.txt', content: 'bad' } }), /unknown/);
  assert.equal(fs.existsSync(path.join(remote, 'after-loss.txt')), false);
  assert.equal(bridge.audit.filter(event => event.event === 'admitted').length, 1);
}
async function lifecycle() {
  await setup([
    { name: 'bash', args: { command: 'mkfifo release; echo READY; read -r _ < release; printf TOOL_FINISHED > safe.txt; echo FINISHED_FOR_HISTORY' } },
    { name: 'read', args: { path: 'safe.txt' } },
  ], { trustedRuntime: true });
  const ready = Promise.withResolvers();
  session.subscribe(event => {
    if (event.type === 'tool_execution_update' && JSON.stringify(event.partialResult).includes('READY')) ready.resolve();
  });
  const prompt = session.prompt('LIFECYCLE_ORIGINAL_INPUT');
  await ready.promise;
  const localSession = session.inspect().sessionFile;
  const checkpointFile = path.join(control, 'sessions/task-1-context.json');
  const entries = () => read(localSession).trim().split('\n').map(JSON.parse);
  const checkpoint = JSON.parse(read(checkpointFile));
  assert.equal(checkpoint.session, localSession);
  assert.equal(checkpoint.task_id, 1); assert.equal(checkpoint.run_id, 1);
  const anchor = entries().find(entry => entry.id === checkpoint.entry);
  assert.ok(anchor);
  assert.ok(!(anchor.message?.role === 'assistant' && anchor.message.content?.some(part => part.type === 'toolCall')));
  assert.ok(entries().some(entry => entry.customType === 'lush.invocation' && entry.data.run_id === 1));
  const requestFile = path.join(control, 'preempt/task-1.request.json');
  const stopFile = path.join(control, 'preempt/task-1.stop.json');
  write(requestFile, JSON.stringify({ task_id: 1, run_id: 1, reason: 'fixture-preemption' }));
  assert.equal(fs.existsSync(stopFile), false); // A live remote tool is not a safe point.
  assert.ok(bridge.pending.size > 0);
  write(path.join(remote, 'release'), 'go\n'); // FIFO releases the real shell, without timing sleeps.
  await prompt;
  assert.equal(requests.length, 1); // Real turn_end hook aborted the automatic next model call.
  assert.equal(fs.existsSync(requestFile), false);
  assert.equal(JSON.parse(read(stopFile)).run_id, 1);
  assert.equal(read(path.join(remote, 'safe.txt')), 'TOOL_FINISHED');
  assert.equal(bridge.pending.size, 0);
  assert.ok(bridge.audit.some(event => event.event === 'command_stopped'));
  const preempted = entries().find(entry => entry.customType === 'lush.preempted');
  assert.equal(preempted.data.safe_point, 'turn_end');
  const after = JSON.parse(read(checkpointFile));
  assert.notEqual(after.entry, checkpoint.entry);
  const persisted = entries();
  const checkpointIndex = persisted.findIndex(entry => entry.id === after.entry);
  const resultIndex = persisted.findIndex(entry => entry.message?.role === 'toolResult');
  // Abort can append another finalized boundary; the checkpoint need not be the
  // toolResult itself, but must include that completed result in its ancestry.
  assert.ok(resultIndex >= 0 && checkpointIndex >= resultIndex, JSON.stringify({ after, persisted }));
  const ancestry = new Map(persisted.map(entry => [entry.id, entry]));
  let cursor = ancestry.get(after.entry);
  while (cursor && cursor.id !== persisted[resultIndex].id) cursor = ancestry.get(cursor.parentId);
  assert.ok(cursor, 'checkpoint ancestry must contain the completed tool result');
  assert.deepEqual(session.inspect().extensionErrors, []);
  await session.close(); // End Run 1 and its execution process before admitting Run 2.
  bridge = new RunnerBridge({ entry, root: remote, home, binding: { ...binding, run: 2, token: randomUUID() } });
  session = await createControlledSession({ entry, config: CONTROLLED_CONFIGURATION, bridge, controlDir: control,
    modelUrl: `http://127.0.0.1:${server.port}/v1`, runtimeContext: runtimeContext(2), sessionFile: localSession });
  assert.equal(session.inspect().sessionFile, localSession);
  await session.prompt('LIFECYCLE_RESUMED_INPUT');
  assert.equal(requests.length, 3);
  assert.ok(JSON.stringify(requests[1]).includes('LIFECYCLE_ORIGINAL_INPUT'));
  assert.ok(JSON.stringify(requests[1]).includes('FINISHED_FOR_HISTORY'));
  assert.ok(JSON.stringify(requests[2]).includes('TOOL_FINISHED'));
  assert.deepEqual(entries().filter(entry => entry.customType === 'lush.invocation').map(entry => entry.data.run_id), [1, 2]);
  assert.equal(JSON.parse(read(checkpointFile)).run_id, 2);
  assert.equal(entries().filter(entry => entry.customType === 'lush.preempted').length, 1);
  assert.deepEqual(session.inspect().extensionErrors, []);
  assert.equal(fs.existsSync(path.join(remote, 'sessions')), false);
  checkModelTools();
}
process.once('SIGTERM', async () => {
  // Harness deadline still gives the SDK/Runner a chance to close active tools.
  try { if (session) await session.close(); else if (bridge) await bridge.close(); }
  finally { server?.stop(true); fs.rmSync(directory, { recursive: true, force: true }); process.exit(143); }
});
try {
  await ({ routing, cancellation, disconnect, lifecycle })[scenario]();
  console.log(JSON.stringify({ scenario, piVersion: session.version, requests: requests.length,
    runnerProcessDistinct: true, assertions: 'passed' }));
} finally {
  try {
    if (session) await session.close();
    else if (bridge) await bridge.close();
  } finally { server?.stop(true); fs.rmSync(directory, { recursive: true, force: true }); }
}
