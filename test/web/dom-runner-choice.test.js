import { beforeEach, afterEach, test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { createRunnerChoice } from '../../src/ui/web/assets/runner-choice.js';
import { createProjectOrderForm } from '../../src/ui/web/assets/project-order-form.js';
import { initComposer, buffer, appendToWorker, resetComposerMode, toggleComposerDetails } from '../../src/ui/web/assets/composer.js';
import { ui } from '../../src/ui/web/assets/state.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';
import { renderDrafts } from '../../src/ui/web/assets/render-drafts.js';

const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb';
const NODE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let dom, calls, intercept, nodes, policy, restore;
beforeEach(() => {
  calls = []; intercept = null;
  nodes = [{ id: NODE, name: '远端一号', enabled: true }, { id: OTHER, name: '未授权节点', enabled: true }];
  policy = { allowed_node_ids: [NODE], default_node_id: NODE };
  dom = installDom({ fetch: async (path, options) => {
    const body = options?.body ? JSON.parse(options.body) : null; calls.push({ path, body });
    const response = intercept?.(path, body); if (response) return response;
    if (path.endsWith('/runner/nodes')) return Response.json({ nodes });
    if (path.endsWith('/runner/project')) return Response.json(policy);
    if (path.endsWith('/input-parents')) return Response.json({ items: [] });
    if (body?.method === 'draft.add' || body?.method === 'draft.update') return Response.json({ id: 10 });
    if (body?.method === 'management.submit') return Response.json({ management: true, task: { id: 5 } });
    if (body?.method === 'input.emit') return Response.json({ emitted: true, draft_id: 10 });
    throw Error(`unexpected ${path}`);
  } });
  restore = registerNavigation({ refresh: async () => {} });
});
afterEach(() => { restore(); dom.restore(); });
const button = (root, text) => root.querySelectorAll('button').find(node => node.textContent === text);
const choose = (root, id) => root.querySelector(`[data-runner-node="${id}"]`).onclick();
const text = value => { dom.node('input').value = value; dom.node('input').oninput(); };
const writes = () => calls.filter(call => call.body).map(call => call.body);

test('lazy deduplicated configuration reads keep omitted default; disabled/deleted/revoked choices never coerce local', async () => {
  const one = createRunnerChoice(), two = createRunnerChoice({ value: NODE });
  expect(calls).toHaveLength(0);
  await Promise.all([one.load(), two.load()]); expect(calls).toHaveLength(2);
  expect(one.value()).toBeUndefined(); expect(deepText(one.node)).toContain('当前预览 远端一号');
  expect(one.node.querySelector(`[data-runner-node="${OTHER}"]`).disabled).toBe(true);
  expect(one.node.querySelector(`[data-runner-node="${OTHER}"]`).parentNode.className).toBe('help-host');
  policy = { allowed_node_ids: [], default_node_id: NODE }; await one.load();
  expect(deepText(one.node)).toContain('授权已撤销'); expect(one.value()).toBeUndefined();
  policy.allowed_node_ids = [NODE]; nodes[0].enabled = false; await two.load();
  expect(deepText(two.node)).toContain('设备节点已禁用'); expect(two.value()).toBe(NODE);
  nodes = []; await two.load(); expect(two.value()).toBe(NODE); expect(deepText(two.node)).toContain('节点已删除');
  expect(calls.every(call => !call.body)).toBe(true);
});

test('late/offline/read failure protects selected identity and does not revive a hidden mode or another project', async () => {
  let active = true, online = true;
  const pending = deferred(); intercept = () => pending.promise;
  const choice = createRunnerChoice({ value: NODE, base: `/p/${A}`, ownsPage: () => active, online: () => online });
  const reading = choice.load(); active = false;
  pending.resolve(Response.json({ nodes, ...policy })); await reading;
  expect(deepText(choice.node)).not.toContain('当前预览'); expect(choice.value()).toBe(NODE);
  active = true; online = false; await choice.load(); expect(calls).toHaveLength(2);
  expect(deepText(choice.node)).toContain('不可达');
  online = true; intercept = () => Response.json({ error: 'offline now' }, { status: 503 }); await choice.load();
  expect(deepText(choice.node)).toContain('读取失败'); expect(choice.value()).toBe(NODE);
  expect(calls.every(call => call.path.startsWith(`/p/${A}/`))).toBe(true);
  choice.setActive(false); expect(choice.node.hidden).toBe(true);
});

test('new boot does not reuse an earlier pending configuration; keyboard choice retains focus', async () => {
  const pending = deferred(); intercept = () => pending.promise;
  const old = createRunnerChoice(); const reading = old.load();
  ui.workerNumbers = new Map(); intercept = null;
  const fresh = createRunnerChoice(); await fresh.load(); expect(calls).toHaveLength(4);
  const local = fresh.node.querySelector('[data-runner-node="local"]'); local.focus(); local.onclick();
  expect(document.activeElement).toBe(fresh.node.querySelector('[data-runner-node="local"]'));
  pending.resolve(Response.json({ nodes, ...policy })); await reading;
  expect(deepText(old.node)).not.toContain('当前预览'); expect(fresh.value()).toBe('local');
});

test('composer More hides environment information and controls without clearing selection or loading on toggle', async () => {
  await initComposer(); const root = dom.node('composer-runner-choice');
  expect(root.hidden).toBe(true);
  expect(dom.node('composer-expand').getAttribute('data-help')).toContain('执行环境');
  expect(calls.some(call => call.path.includes('/runner/'))).toBe(false);
  await toggleComposerDetails(true); expect(root.hidden).toBe(false);
  await button(root, '更改执行环境').onclick(); choose(root, NODE);
  await toggleComposerDetails(false); expect(root.hidden).toBe(true);
  const reads = calls.filter(call => call.path.includes('/runner/')).length;
  await toggleComposerDetails(true); expect(root.hidden).toBe(false);
  expect(ui.composerRunnerNodeId).toBe(NODE);
  expect(root.querySelector(`[data-runner-node="${NODE}"]`).getAttribute('aria-pressed')).toBe('true');
  expect(calls.filter(call => call.path.includes('/runner/'))).toHaveLength(reads);
  ui.view = { id: 'task' }; ui.selected = 3;
  appendToWorker({ id: 3, task_kind: 'order', status: 'running', branch: 'work' });
  expect(root.hidden).toBe(true);
  resetComposerMode(); expect(root.hidden).toBe(false);
  ui.composerManagement = true; ui.syncComposer(); expect(root.hidden).toBe(true);
  expect(ui.composerRunnerNodeId).toBe(NODE); expect(writes()).toHaveLength(0);
});

test('composer selection enters direct/buffer fingerprints, failure and in-flight edits survive; append/management omit selection', async () => {
  await initComposer(); const root = dom.node('composer-runner-choice');
  await button(root, '更改执行环境').onclick(); choose(root, NODE); text('first');
  intercept = (_path, body) => body ? Response.json({ error: 'unknown write' }, { status: 503 }) : null;
  await dom.node('input-form').onsubmit({ preventDefault() {} });
  expect(dom.node('input').value).toBe('first'); expect(ui.composerRunnerNodeId).toBe(NODE);
  const first = writes().at(-1); await dom.node('input-form').onsubmit({ preventDefault() {} });
  expect(writes().at(-1).params.client_request_id).toBe(first.params.client_request_id);
  choose(root, 'local'); await dom.node('input-form').onsubmit({ preventDefault() {} });
  expect(writes().at(-1).params.client_request_id).not.toBe(first.params.client_request_id);
  const pending = deferred(); intercept = (_path, body) => body ? pending.promise : null;
  const sending = buffer(); choose(root, NODE); // same text but new choice is a new edit
  pending.resolve(Response.json({ id: 12 })); await sending;
  expect(dom.node('input').value).toBe('first'); expect(ui.composerRunnerNodeId).toBe(NODE);
  intercept = null;
  ui.view = { id: 'task' }; ui.selected = 3;
  appendToWorker({ id: 3, task_kind: 'order', status: 'running', branch: 'work', goal: 'append target' });
  expect(root.querySelector('.runner-input-choice').hidden).toBe(true);
  await buffer(); expect(writes().at(-1).params.mode).toBe('append'); expect(writes().at(-1).params).not.toHaveProperty('runner_node_id');
  resetComposerMode(); expect(ui.composerRunnerNodeId).toBe(NODE);
  ui.composerManagement = true; ui.syncComposer(); text('management');
  expect(root.querySelector('.runner-input-choice').hidden).toBe(true);
  await dom.node('input-form').onsubmit({ preventDefault() {} });
  expect(writes().at(-1).method).toBe('management.submit'); expect(writes().at(-1).params).not.toHaveProperty('runner_node_id');
  resetComposerMode(); text('explicit local'); choose(root, 'local'); await buffer();
  expect(writes().at(-1).params.runner_node_id).toBe('local'); expect(ui.composerRunnerNodeId).toBeUndefined();
  text('omitted'); await buffer(); expect(writes().at(-1).params).not.toHaveProperty('runner_node_id');
});

test('legacy draft panel emits only persisted revision and text edits omit runner selection, retaining failure text', async () => {
  await initComposer();
  const draft = { id: 10, revision: 4, content: 'legacy text', references: [], runner_node_id: NODE };
  renderDrafts({ drafts: [draft] });
  const root = dom.node('drafts');
  expect(deepText(root)).toContain(NODE);
  button(root, '编辑').onclick();
  const box = root.querySelector('textarea'); box.value = 'keep changed text';
  intercept = (_path, body) => body ? Response.json({ error: 'revision conflict' }, { status: 409 }) : null;
  await box.listeners.blur[0]();
  expect(box.value).toBe('keep changed text'); expect(ui.draftEditing).toBe(10);
  expect(writes().at(-1)).toEqual({ method: 'draft.update', params: { id: 10, content: 'keep changed text', expected_revision: 4 } });
  box.listeners.keydown[0]({ key: 'Escape', preventDefault() {} }); intercept = null;
  await button(root, '发送').onclick();
  expect(writes().at(-1)).toEqual({ method: 'input.emit', params: { draft_id: 10, expected_revision: 4 } });
});

test('global project form keeps source, offline choice, session draft and ACK edits isolated', async () => {
  dom.location.pathname = `/p/${B}/`;
  const form = createProjectOrderForm({ id: A, name: 'A', running: true });
  const input = form.root.querySelector('textarea'); input.value = 'global text'; input.oninput();
  await button(form.root, '更改执行环境').onclick(); choose(form.root, NODE);
  const pending = deferred(); intercept = (_path, body) => body ? pending.promise : null;
  const submit = button(form.root, '提交指令');
  expect(submit.classList.contains('agent-call')).toBe(true); expect(submit.getAttribute('data-help')).toContain('token');
  const sending = submit.onclick(); choose(form.root, 'local');
  pending.resolve(Response.json({ emitted: true, draft_id: 19 })); await sending;
  expect(input.value).toBe('global text');
  const second = createProjectOrderForm({ id: A, running: false });
  expect(second.root.querySelector('[data-runner-node="local"]').getAttribute('aria-pressed')).toBe('true');
  await button(second.root, '更改执行环境').onclick();
  expect(calls).toHaveLength(3); expect(calls.every(call => call.path.startsWith(`/p/${A}/`))).toBe(true);
  expect(writes()[0].params.runner_node_id).toBe(NODE);
  const other = createProjectOrderForm({ id: B, running: true }); expect(other.root.querySelector('textarea').value).toBe('');
  expect(other.root.querySelector('[data-runner-node="default"]').getAttribute('aria-pressed')).toBe('true');
});
