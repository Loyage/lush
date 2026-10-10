import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { createProjectOrderForm } from '../../src/ui/web/assets/project-order-form.js';

const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb';
const row = (id = A, running = true) => ({ id, name: `项目 ${id[0]}`, running });
let dom, calls, reply;
beforeEach(() => {
  calls = []; reply = () => Response.json({ task: { id: 17, worker_number: 'W8', status: 'paused' } });
  dom = installDom({ fetch: async (url, options) => { calls.push({ url: String(url), body: JSON.parse(options.body) }); return reply(); } });
});
afterEach(() => dom.restore());
const inputOf = form => form.root.querySelector('textarea');
const controls = form => form.root.querySelectorAll('button');
const type = (form, value) => { inputOf(form).value = value; inputOf(form).oninput(); };
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };

test('fixed source and main parent, create only does not start Agent or leave the global view', async () => {
  const form = createProjectOrderForm(row()); type(form, '独立工作');
  expect(controls(form)[0].classList.contains('agent-call')).toBe(false);
  expect(controls(form)[1].classList.contains('agent-call')).toBe(true);
  expect(controls(form)[1].getAttribute('data-help')).toContain('token');
  await controls(form)[0].onclick();
  expect(calls).toEqual([{ url: `/p/${A}/api/action`, body: { method: 'order.submit', params: { content: '独立工作', branch: 'main', start: false } } }]);
  expect(inputOf(form).value).toBe(''); expect(controls(form).every(node => node.disabled)).toBe(true);
  expect(deepText(form.root)).toContain('待开始');
  expect(form.root.querySelector('a').href).toBe(`/p/${A}/#worker-17`);
  expect(form.root.querySelector('a').textContent).toBe('查看 Worker W8'); expect(dom.location.pathname).toBe('/');
});

test('explicit create-and-start uses the source daemon even from another project route', async () => {
  dom.location.pathname = `/p/${B}/`;
  const form = createProjectOrderForm(row()); type(form, '立即执行'); await controls(form)[1].onclick();
  expect(calls[0].url).toBe(`/p/${A}/api/action`); expect(calls[0].body.params.start).toBe(true);
  expect(deepText(form.root)).toContain('已请求开始'); expect(deepText(form.root)).not.toContain('正在执行');
});

test('offline and blank forms cannot send, even with direct handler invocation; offline drafts survive', async () => {
  const form = createProjectOrderForm(row(A, false)); type(form, '离线想法');
  expect(controls(form).every(node => node.disabled)).toBe(true);
  expect(controls(form)[1].parentNode.getAttribute('data-help')).toContain('不可达');
  await controls(form)[0].onclick(); await controls(form)[1].onclick(); expect(calls).toHaveLength(0);
  form.update(row()); expect(inputOf(form).value).toBe('离线想法'); expect(controls(form)[0].disabled).toBe(false);
  type(form, '  '); await controls(form)[1].onclick(); expect(calls).toHaveLength(0);
});

test('single-flight across both buttons and refreshed forms; successful old input never clears new editing', async () => {
  const pending = deferred(); reply = () => pending.promise;
  const form = createProjectOrderForm(row()); type(form, '第一条');
  const sending = controls(form)[1].onclick(); await controls(form)[0].onclick();
  const refreshed = createProjectOrderForm(row()); await controls(refreshed)[1].onclick();
  expect(controls(refreshed)[0].disabled).toBe(true); expect(calls).toHaveLength(1);
  type(refreshed, '下一条'); pending.resolve(Response.json({ task: { id: 18, worker_number: null } })); await sending;
  expect(inputOf(refreshed).value).toBe('下一条'); expect(controls(refreshed)[0].disabled).toBe(false);
  expect(refreshed.root.querySelector('a').textContent).toBe('查看 Worker #18');
});

test('send failure preserves text and never retries writes or starts an offline daemon', async () => {
  reply = () => Response.json({ error: 'daemon unavailable' }, { status: 503 });
  const form = createProjectOrderForm(row()); type(form, '保留原文'); await controls(form)[1].onclick();
  expect(inputOf(form).value).toBe('保留原文'); expect(calls).toHaveLength(1);
  expect(deepText(form.root)).toContain('未确认创建成功'); expect(deepText(form.root)).toContain('避免重复创建');
  expect(form.root.querySelector('a')).toBeNull();
});

test('project drafts remain isolated on navigation and invalid identities are rejected before fetch', () => {
  const first = createProjectOrderForm(row(A)); type(first, 'A 的想法');
  const second = createProjectOrderForm(row(B)); type(second, 'B 的想法');
  expect(inputOf(createProjectOrderForm(row(A))).value).toBe('A 的想法');
  expect(inputOf(createProjectOrderForm(row(B))).value).toBe('B 的想法');
  expect(() => first.update(row(B))).toThrow('目标项目');
  expect(() => createProjectOrderForm(row('../outside'))).toThrow('项目身份'); expect(calls).toHaveLength(0);
});

test('navigation and replacement document block old controls and late paint, while ACK is remembered', async () => {
  const pending = deferred(); reply = () => pending.promise; let current = true;
  const form = createProjectOrderForm(row(), { ownsPage: () => current }); type(form, '已发出');
  const sending = controls(form)[0].onclick(); current = false;
  pending.resolve(Response.json({ task: { id: 20 } })); await sending;
  expect(inputOf(form).value).toBe('已发出'); expect(calls).toHaveLength(1);
  await controls(form)[1].onclick(); expect(calls).toHaveLength(1);
  const fresh = createProjectOrderForm(row()); expect(inputOf(fresh).value).toBe(''); expect(deepText(fresh.root)).toContain('待开始');
  const replacement = installDom({ fetch: () => { throw Error('old document wrote to replacement'); } });
  try { await controls(fresh)[1].onclick(); expect(calls).toHaveLength(1); } finally { replacement.restore(); }
});
