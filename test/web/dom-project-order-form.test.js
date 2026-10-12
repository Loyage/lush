import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { createProjectOrderForm } from '../../src/ui/web/assets/project-order-form.js';

const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb';
const row = (id = A, running = true) => ({ id, name: `项目 ${id[0]}`, running });
let dom, calls, reply;
beforeEach(() => {
  calls = []; reply = () => Response.json({ emitted: true, draft_id: 17, dispatch: { state: 'queued' } });
  dom = installDom({ fetch: async (url, options) => { calls.push({ url: String(url), body: JSON.parse(options.body) }); return reply(); } });
});
afterEach(() => dom.restore());
const inputOf = form => form.root.querySelector('textarea');
const control = form => form.root.querySelector('button');
const type = (form, value) => { inputOf(form).value = value; inputOf(form).oninput(); };
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };

test('fixed source and main parent, emission schedules Agent without claiming creation or leaving global view', async () => {
  const form = createProjectOrderForm(row()); type(form, '独立工作');
  expect(control(form).classList.contains('agent-call')).toBe(true); expect(control(form).getAttribute('data-help')).toContain('token');
  expect(form.root.querySelectorAll('button')).toHaveLength(1);
  await control(form).onclick();
  expect(calls[0]).toMatchObject({ url: `/p/${A}/api/action`, body: { method: 'input.emit', params: { content: '独立工作', branch: 'main' } } });
  expect(calls[0].body.params.client_request_id).toBeTruthy(); expect(calls[0].body.params).not.toHaveProperty('start');
  expect(inputOf(form).value).toBe(''); expect(control(form).disabled).toBe(true);
  expect(deepText(form.root)).toContain('尚不代表 Worker 已创建'); expect(form.root.querySelector('a').href).toBe(`/p/${A}/#input-draft-17`);
  expect(dom.location.pathname).toBe('/');
});

test('emission uses the explicit source daemon even from another project route', async () => {
  dom.location.pathname = `/p/${B}/`;
  const form = createProjectOrderForm(row()); type(form, '执行需求'); await control(form).onclick();
  expect(calls[0].url).toBe(`/p/${A}/api/action`); expect(deepText(form.root)).toContain('等待父 runtime');
});

test('offline and blank forms cannot send even by direct handler; offline text survives', async () => {
  const form = createProjectOrderForm(row(A, false)); type(form, '离线想法');
  expect(control(form).disabled).toBe(true); expect(control(form).parentNode.getAttribute('data-help')).toContain('不可达');
  await control(form).onclick(); expect(calls).toHaveLength(0);
  form.update(row()); expect(inputOf(form).value).toBe('离线想法'); expect(control(form).disabled).toBe(false);
  type(form, '  '); await control(form).onclick(); expect(calls).toHaveLength(0);
});

test('single-flight persists across refreshed forms; old ACK never clears newer editing', async () => {
  const pending = deferred(); reply = () => pending.promise;
  const form = createProjectOrderForm(row()); type(form, '第一条'); const sending = control(form).onclick(); await control(form).onclick();
  const refreshed = createProjectOrderForm(row()); await control(refreshed).onclick();
  expect(control(refreshed).disabled).toBe(true); expect(calls).toHaveLength(1);
  type(refreshed, '下一条'); pending.resolve(Response.json({ emitted: true, draft_id: 18, dispatch: { state: 'queued' } })); await sending;
  expect(inputOf(refreshed).value).toBe('下一条'); expect(control(refreshed).disabled).toBe(false);
  expect(refreshed.root.querySelector('a').textContent).toBe('查看发射状态');
});

test('unknown failure preserves text and retry identity, never starts offline daemon or retries automatically', async () => {
  reply = () => Response.json({ error: 'daemon unavailable' }, { status: 503 });
  const form = createProjectOrderForm(row()); type(form, '保留原文'); await control(form).onclick();
  expect(inputOf(form).value).toBe('保留原文'); expect(calls).toHaveLength(1);
  expect(deepText(form.root)).toContain('未确认发射成功'); expect(form.root.querySelector('a')).toBeNull();
  const id = calls[0].body.params.client_request_id; await control(form).onclick(); expect(calls[1].body.params.client_request_id).toBe(id);
});

test('project text remains isolated on navigation and invalid identities are rejected before fetch', () => {
  const first = createProjectOrderForm(row(A)); type(first, 'A 的想法'); const second = createProjectOrderForm(row(B)); type(second, 'B 的想法');
  expect(inputOf(createProjectOrderForm(row(A))).value).toBe('A 的想法'); expect(inputOf(createProjectOrderForm(row(B))).value).toBe('B 的想法');
  expect(() => first.update(row(B))).toThrow('目标项目'); expect(() => createProjectOrderForm(row('../outside'))).toThrow('项目身份'); expect(calls).toHaveLength(0);
});

test('navigation or replacement document blocks old controls/late paint while acknowledged state is retained', async () => {
  const pending = deferred(); reply = () => pending.promise; let current = true;
  const form = createProjectOrderForm(row(), { ownsPage: () => current }); type(form, '已发出'); const sending = control(form).onclick(); current = false;
  pending.resolve(Response.json({ emitted: true, draft_id: 20 })); await sending;
  expect(inputOf(form).value).toBe('已发出'); expect(calls).toHaveLength(1); await control(form).onclick(); expect(calls).toHaveLength(1);
  const fresh = createProjectOrderForm(row()); expect(inputOf(fresh).value).toBe(''); expect(deepText(fresh.root)).toContain('等待父 runtime');
  const replacement = installDom({ fetch: () => { throw Error('old document wrote to replacement'); } });
  try { await control(fresh).onclick(); expect(calls).toHaveLength(1); } finally { replacement.restore(); }
});
