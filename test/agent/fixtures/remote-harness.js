import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Store } from '../../../src/persistence/store.js';
import { RunnerSettings } from '../../../src/core/runner-settings.js';
import { RunnerClient, StdioTransport } from '../../../src/runner/index.js';
import { hash } from '../../../src/runner/protocol.js';
import { RunnerToolBridge, RemoteBridgeClient } from '../../../src/agent/remote-bridge.js';
import { REMOTE_PI_VERSION } from '../../../src/agent/remote-contract.js';
import { Dispatcher } from '../../../src/rpc/dispatcher.js';
import scheduling from '../../../src/core/project/scheduling.js';
import messages from '../../../src/core/project/messages.js';
import { tokenHash } from '../../../src/core/project/internal.js';

export const IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
export const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, content, { mode: 0o600 }); };
export async function remoteHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-remote-sdk-'));
  const control = path.join(root, 'control'), agentDir = path.join(root, 'agent'), sessions = path.join(control, 'sessions');
  for (const dir of [control, agentDir, sessions]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const store = new Store(path.join(root, 'central.db'), root);
  const settings = new RunnerSettings({ home: path.join(root, 'device') });
  const node = settings.save({ nodes: [{ name: 'fixture', ssh_alias: 'fixture', enabled: true, budgets: { max_commands: 1, timeout_ms: 5000, output_bytes: 1048576 } }] }, settings.read().revision).nodes[0];
  const policy = store.saveRunnerProject({ allowed_node_ids: [node.id], default_node_id: node.id }, 0).policy;
  const machine_token = hash('machine'), control_token = hash('control'), run_token = hash('run');
  const nodeFile = path.join(root, 'node.json');
  write(nodeFile, JSON.stringify({ version: 1, root: path.join(root, 'runner'), node_id: node.id,
    machine_token_hash: hash(machine_token), projects: { [policy.project_id]: { control_token_hash: hash(control_token) } },
    cgroup_root: path.join(root, 'fixture-adapter-not-cgroup'), memory_reserve_bytes: 0 }));
  const worker = store.create({ input_id: null, role: 'agent', task_kind: 'order', goal: 'controlled remote test' });
  const transport = new StdioTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../../runner/fixtures/integration-node.js', import.meta.url)), nodeFile], env: { PATH: '/usr/bin:/bin', HOME: root } });
  const central = new RunnerClient({ transport, identity: { project_id: policy.project_id, node_id: node.id,
    worker_id: worker.id, workspace_id: 'remote-workspace', generation: 1, operation_id: 'setup' },
    auth: { machine_token, control_token }, budgets: { timeout_ms: 5000, output_bytes: 1024 * 1024 } });
  await central.handshake();
  const { operation_id, ...base } = central.identity;
  const bound = store.bindRunnerWorkspace({ ...base, base_commit: 'a'.repeat(40) });
  const workspace = await central.call('workspace.register');
  store.confirmRunnerWorkspace(base, bound.head_commit, bound.revision);
  const remote = workspace.directory;
  write(path.join(remote, 'same.txt'), 'REMOTE_FIRST\nREMOTE_SECOND\n');
  write(path.join(remote, 'AGENTS.md'), 'REMOTE_ROOT_RULES');
  write(path.join(remote, 'nested/AGENTS.md'), 'SUPPRESSED_RULES');
  write(path.join(remote, 'nested/AGENTS.override.md'), 'REMOTE_NESTED_RULES');
  write(path.join(remote, 'picture.png'), Buffer.from(IMAGE, 'base64'));
  write(path.join(remote, '.pi/extensions/poison.js'), `throw new Error('REMOTE_EXTENSION_MUST_NOT_EXECUTE')`);
  execFileSync('/usr/bin/git', ['init', '-q', remote]);
  write(path.join(control, 'same.txt'), 'LOCAL_POISON');
  write(path.join(control, 'AGENTS.md'), 'LOCAL_CONTEXT_POISON');
  write(path.join(control, '.pi/settings.json'), JSON.stringify({ packages: ['npm:NEVER_INSTALL'], extensions: ['./poison.js'] }));
  write(path.join(control, '.pi/poison.js'), 'throw new Error("LOCAL_EXTENSION_POISON")');
  write(path.join(control, 'startup.json'), '{"startup":"CONTROL_STARTUP"}');
  const active = store.update(worker.id, { status: 'running' });
  const run = store.startRun(active, { agent: 'mock' });
  const identity = { ...base, run_id: run.id };
  const authorization = store.authorizeRunnerRun(identity, policy.authorization_version);
  await central.call('lease.grant', { run_id: run.id, run_token, ttl_ms: 120000 });
  const client = central.forRun({ run_id: run.id, run_token });
  const token = randomUUID(); store.armAgent(worker.id, tokenHash(token));
  const controller = new AbortController();
  const project = { store, running: new Map([[worker.id, { controller }]]), actor: scheduling.actor,
    notice: messages.notice, questionPending: scheduling.questionPending, parkForQuestion: scheduling.parkForQuestion,
    suspendTaskMerge: () => {}, autoAnswerNotice: () => {}, scheduleTaskHooks: () => {} };
  const dispatcher = new Dispatcher(project);
  let checks = 0;
  const bridge = new RunnerToolBridge({ client, identity, token, path: remote,
    authorize: ({ identity: current, token: credential }) => {
      checks++;
      if (project.actor(credential) !== current.worker_id) throw new Error('wrong actor');
      store.assertRunnerAuthorization(current, authorization.authorization_version);
      if (!settings.read().nodes.find(n => n.id === current.node_id)?.enabled) throw new Error('disabled node');
    },
    cooperate: ({ method, params, token }) => dispatcher.dispatch(method, { ...params, _token: token }),
    control: { directory: control, resources: { startup: path.join(control, 'startup.json') } },
  });
  await bridge.listen(path.join(control, 'bridge.sock'));
  const descriptor = { version: 1, runner_protocol: 1, pi_version: REMOTE_PI_VERSION, socket: bridge.socket, identity, path: remote };
  const rpc = new RemoteBridgeClient(descriptor, token);
  return { root, remote, control, agentDir, sessions, store, settings, node, worker: store.task(worker.id), run, client, central,
    token, descriptor, bridge, rpc, controller, checks: () => checks, secrets: [machine_token, control_token, run_token, token],
    close: async () => { await bridge.close(); await central.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
export function modelServer(script, hooks = {}) {
  const requests = []; let step = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json(); requests.push(body);
    const action = typeof script === 'function' ? await script(step++, body) : script[step++];
    await hooks.before?.(step, body);
    const delta = action ? { tool_calls: [{ index: 0, id: `call_${step}`, type: 'function',
      function: { name: action.name, arguments: JSON.stringify(action.args) } }] } : { content: 'remote complete' };
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: `response_${step}`, object: 'chat.completion.chunk',
      created: 1, model: 'controlled', choices: [{ index: 0, delta, finish_reason }],
      ...(finish_reason ? { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } } : {}) })}\n\n`;
    return new Response(chunk({ role: 'assistant' }) + chunk(delta) + chunk({}, action ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  return { server, requests, url: `http://127.0.0.1:${server.port}/v1` };
}
