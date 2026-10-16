import { test, expect, afterAll } from 'bun:test';
import { runnerProject } from '../project/fixtures/runner-project.js';
import { until } from '../helpers.js';
import { RPCServer } from '../../src/rpc/server.js';
import { RemoteBridgeClient } from '../../src/agent/remote-bridge.js';
import { startTestWeb, fetch as httpFetch } from './auth-fixture.js';
import { installDom, deepText } from '../dom-stub.js';

let fixture, url, calls = [];
const nativeInterval = globalThis.setInterval;
const dom = installDom({ fetch: (path, options) => {
  calls.push({ path, ...(options?.body ? JSON.parse(options.body) : {}) });
  return httpFetch(url + path, options);
} });
// The real Runner heartbeat needs native timers; only browser DOM is stubbed.
globalThis.setInterval = nativeInterval;
const { resetUiState } = await import('../../src/ui/web/assets/state.js');
const { initComposer, buffer } = await import('../../src/ui/web/assets/composer.js');
const { openInputs } = await import('../../src/ui/web/assets/render-inputs.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
afterAll(() => dom.restore());
const button = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const select = (root, id) => root.querySelector(`[data-runner-node="${id}"]`).onclick();
async function setup() {
  fixture = await runnerProject({ async run(ctx) {
    const bridge = new RemoteBridgeClient(ctx.remote_workspace, ctx.token);
    const context = await bridge.call('context');
    await bridge.call('tool', { name: 'write', args: { path: 'page-choice.txt', content: 'page selection', context_ack: context.fingerprint } });
    const committed = await bridge.call('tool', { name: 'bash', args: { context_ack: context.fingerprint,
      command: 'git add page-choice.txt && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m page-choice' } });
    expect(committed.isError).toBe(false);
    return 'controlled page creation';
  } });
  fixture.project.stopping = true;
  const rpc = new RPCServer(fixture.config.socket, fixture.dispatcher); await rpc.start();
  const web = startTestWeb(fixture.config); url = `http://127.0.0.1:${web.port}`; calls = [];
  resetUiState(); dom.node('input').value = ''; dom.node('input-parent').value = '';
  const restore = registerNavigation({ refresh: async () => {} });
  await initComposer();
  return async () => { restore(); web.stop(true); await rpc.close(); await fixture.close(); };
}
function input(text) { dom.node('input').value = text; dom.node('input').oninput(); }
const send = () => dom.node('input-form').onsubmit({ preventDefault() {} });
const post = async (method, params) => {
  const response = await httpFetch(url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
  return { status: response.status, body: await response.json() };
};

test('page -> real HTTP/RPC -> SQLite: explicit remote draft edit/conditions preserve choice; emission cannot override it', async () => {
  const close = await setup();
  try {
    const root = dom.node('composer-runner-choice'), selected = fixture.nodes[1].id;
    expect(calls.filter(call => call.path.includes('/runner/'))).toHaveLength(0);
    await button(root, '更改执行环境').onclick();
    expect(deepText(root)).toContain('当前预览 A');
    select(root, selected); input('page remote draft'); await buffer();
    const draft = fixture.store.all('SELECT * FROM drafts')[0];
    expect(JSON.parse(draft.input_options).runner_node_id).toBe(selected);
    await openInputs({ item: { kind: 'draft', id: draft.id } });
    const panel = dom.node('detail').querySelector('.input-detail');
    await button(panel, '更改执行环境').onclick();
    expect(panel.querySelector('[data-runner-node="default"]').disabled).toBe(false);
    select(panel, 'local'); await button(panel, '保存').onclick();
    expect(JSON.parse(fixture.store.draft(draft.id).input_options).runner_node_id).toBe('local');
    select(panel, selected);
    panel.querySelector('textarea').value = 'edited with conditions'; panel.querySelector('textarea').oninput();
    await button(panel, '执行条件设置').onclick();
    const quiet = panel.querySelector('.emission-conditions').querySelectorAll('input').find(node => node.type === 'checkbox');
    quiet.checked = true; quiet.onchange();
    await button(panel, '保存').onclick();
    const saved = fixture.store.draft(draft.id), options = JSON.parse(saved.input_options);
    expect(options.runner_node_id).toBe(selected); expect(options.conditions.length).toBeGreaterThan(0);
    expect((await post('input.emit', { draft_id: draft.id, expected_revision: saved.revision, runner_node_id: 'local' })).status).toBe(400);
    await button(panel, '按条件提交').onclick();
    expect(deepText(panel)).toContain('执行环境：'); expect(panel.querySelector('textarea')).toBeNull();
    const emit = calls.filter(call => call.method === 'input.emit').at(-1);
    expect(emit.params).toMatchObject({ draft_id: draft.id, expected_revision: saved.revision });
    expect(Object.hasOwn(emit.params, 'runner_node_id')).toBe(false);
    expect(JSON.parse(fixture.store.draft(draft.id).input_options).runner_node_id).toBe(selected);
    expect(fixture.store.all('SELECT * FROM agent_runs')).toHaveLength(0);
    expect(calls.some(call => call.method === 'runner.nodes.check')).toBe(false);
  } finally { await close(); }
});

test('D655 page reset -> real HTTP/RPC removes override; creation resolves default changed after emission', async () => {
  const close = await setup();
  try {
    const root = dom.node('composer-runner-choice'), original = fixture.nodes[0].id, eventual = fixture.nodes[1].id;
    await button(root, '更改执行环境').onclick(); select(root, original); input('reset through real page'); await buffer();
    const draft = fixture.store.all('SELECT * FROM drafts')[0];
    expect(JSON.parse(draft.input_options).runner_node_id).toBe(original);
    await openInputs({ item: { kind: 'draft', id: draft.id } });
    const panel = dom.node('detail').querySelector('.input-detail');
    await button(panel, '更改执行环境').onclick(); select(panel, 'default');
    await button(panel, '保存').onclick();
    expect(calls.filter(call => call.method === 'draft.update').at(-1).params)
      .toMatchObject({ id: draft.id, expected_revision: draft.revision, runner_node_id: null });
    const saved = fixture.store.draft(draft.id);
    expect(JSON.parse(saved.input_options)).not.toHaveProperty('runner_node_id');
    const readback = await (await httpFetch(url + `/api/input/draft/${draft.id}`)).json();
    expect(readback).not.toHaveProperty('runner_node_id');
    expect(button(panel, '保存').disabled).toBe(true);
    expect(deepText(panel)).toContain('实际创建时解析');
    await button(panel, '提交指令').onclick();
    const emitted = calls.filter(call => call.method === 'input.emit').at(-1);
    expect(emitted.params).toMatchObject({ draft_id: draft.id, expected_revision: saved.revision });
    expect(emitted.params).not.toHaveProperty('runner_node_id');
    const policy = fixture.service.readPolicy();
    expect(policy.default_node_id).toBe(original);
    await fixture.service.savePolicy({ allowed_node_ids: policy.allowed_node_ids, default_node_id: eventual }, policy.revision);
    fixture.project.stopping = false; await fixture.project.drainInputEmissions(); fixture.project.kick();
    const result = fixture.project.inputEmissionResult(draft.id);
    expect(result.dispatch.state).toBe('succeeded');
    const worker = result.dispatch.worker_id;
    await until(() => !fixture.project.running.has(worker) && fixture.store.task(worker).calls === 1, 8000);
    expect(fixture.store.runnerBinding(worker).node_id).toBe(eventual);
    expect(fixture.store.task(worker).result).toBe('controlled page creation');
    expect(fixture.store.task(worker).error).toBeNull();
    const fixed = fixture.store.draft(draft.id);
    expect((await post('draft.update', { id: draft.id, content: draft.content, expected_revision: fixed.revision, runner_node_id: null })).status).toBe(400);
    expect(fixture.store.draft(draft.id)).toEqual(fixed);
  } finally { await close(); }
});

test('page direct explicit UUID reaches actual creation; default omitted and revoked default fails without local fallback', async () => {
  const close = await setup();
  try {
    const root = dom.node('composer-runner-choice'), selected = fixture.nodes[1].id;
    await button(root, '更改执行环境').onclick(); select(root, selected); input('page selected remote'); await send();
    const draft = fixture.store.all('SELECT * FROM drafts')[0];
    expect(JSON.parse(draft.input_options).runner_node_id).toBe(selected);
    fixture.project.stopping = false; await fixture.project.drainInputEmissions(); fixture.project.kick();
    const result = fixture.project.inputEmissionResult(draft.id);
    expect(result.dispatch.state).toBe('succeeded');
    const worker = result.dispatch.worker_id;
    await until(() => !fixture.project.running.has(worker) && fixture.store.task(worker).calls === 1, 8000);
    expect(fixture.store.runnerBinding(worker).node_id).toBe(selected);
    expect({ error: fixture.store.task(worker).error, result: fixture.store.task(worker).result }).toEqual({ error: null, result: 'controlled page creation' });
    fixture.project.stopping = true;
    input('use future default'); await buffer();
    const omitted = fixture.store.all('SELECT * FROM drafts').at(-1);
    expect(Object.hasOwn(JSON.parse(omitted.input_options), 'runner_node_id')).toBe(false);
    await openInputs({ item: { kind: 'draft', id: omitted.id } });
    const panel = dom.node('detail').querySelector('.input-detail');
    panel.querySelector('textarea').value = 'old omitted stays omitted'; panel.querySelector('textarea').oninput();
    await button(panel, '保存').onclick();
    expect(Object.hasOwn(JSON.parse(fixture.store.draft(omitted.id).input_options), 'runner_node_id')).toBe(false);
    const policy = fixture.service.readPolicy();
    await fixture.service.savePolicy({ allowed_node_ids: [], default_node_id: policy.default_node_id }, policy.revision);
    await button(root, '刷新配置预览').onclick();
    expect(deepText(root)).toContain('授权已撤销');
    input('revoked default must fail'); await send();
    const revoked = fixture.store.all('SELECT * FROM drafts').at(-1);
    fixture.project.stopping = false; await fixture.project.drainInputEmissions(); fixture.project.stopping = true;
    expect(fixture.project.inputEmissionResult(revoked.id).dispatch.state).toBe('failed');
    expect(fixture.store.all("SELECT * FROM tasks WHERE goal='revoked default must fail'")).toHaveLength(0);
    const key = 'runner-page-fingerprint';
    const first = await post('input.emit', { content: 'same identity', branch: 'main', runner_node_id: 'local', client_request_id: key });
    expect(first.status).toBe(200);
    expect((await post('input.emit', { content: 'same identity', branch: 'main', client_request_id: key })).status).toBe(400);
  } finally { await close(); }
});
