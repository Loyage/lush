import { test, expect, afterEach } from 'bun:test';
import { installDom, deepText, answerDialog, dialogButton } from './project-dom.js';
import { until, gate } from '../helpers.js';
import { ui } from '../../src/ui/web/assets/state.js';
import { integrationControl, integrationDetails, integrationSummary } from '../../src/ui/web/assets/render-integration.js';

const sha = 'a'.repeat(40), target = { id: 1, task_kind: 'main', branch: 'main', status: 'waiting' };
const members = [{ id: 2, worker_number: 'W5', title: '功能 A', source_commit: sha, base_commit: 'b'.repeat(40) }];
const operation = (extra = {}) => ({ version: 1, id: 10, revision: 'operation-rev', target_branch: 'main', state: 'resolving',
  worker: { id: 9, worker_number: null, status: 'running' }, member_count: 1, members: [...members], members_truncated: false, baseline: sha, commit: null, error: null, ...extra });
const plan = (extra = {}) => ({ version: 1, branch: 'main', revision: 'plan-rev', target: { id: 1, branch: 'main' },
  members: [...members], count: 1, excluded: [{ id: 3, worker_number: 'W6', reason: '还有未处理输入' }], ready: true, reason: null, active: null, ...extra });
let dom;
afterEach(() => { dom?.restore(); dom = null; });
function mount(fetch, refresh = async () => {}) {
  const requests = [];
  dom = installDom({ fetch: async (url, options) => { requests.push({ url: String(url), options }); return fetch(url, options); } });
  ui.view = { id: 'task' };
  const root = integrationControl(target, { refresh }); dom.node('detail').append(root);
  return { root, requests, start: root.querySelector('button') };
}
const startDialog = async start => { const pending = start.onclick(); await until(() => dialogButton(dom, '开始整合')); return { pending }; };

test('explicit preflight confirms exact members, excluded reasons and cost, then starts once with revision', async () => {
  let posts = 0;
  const { root, requests, start } = mount(async (_, options) => options?.method === 'POST' ? (posts++, Response.json(operation())) : Response.json(plan()));
  expect(requests).toHaveLength(0); expect(start.classList.contains('agent-call')).toBe(true);
  expect(start.getAttribute('data-help')).toContain('token');
  const { pending } = await startDialog(start);
  expect(deepText(dom.node('modal'))).toContain('W5 功能 A'); expect(deepText(dom.node('modal'))).toContain('W6 · 还有未处理输入');
  expect(deepText(dom.node('modal'))).toContain('一个整合 Worker'); expect(posts).toBe(0);
  await answerDialog(dom, '开始整合'); await pending;
  expect(posts).toBe(1);
  expect(JSON.parse(requests.at(-1).options.body)).toEqual({ method: 'branch.integrate_start', params: { branch: 'main', expected_revision: 'plan-rev' } });
  expect(start.disabled).toBe(true); await start.onclick(); expect(posts).toBe(1);
  expect(deepText(root)).toContain('尚不表示代码已合入');
  expect(root.querySelector('.integration-summary').querySelector('a').getAttribute('href')).toContain('#worker-9');
  expect(deepText(root)).not.toContain('交付');
});

test('cancelled confirmation and non-ready plan never create a Worker', async () => {
  const { start, requests } = mount(() => Response.json(plan()));
  const { pending } = await startDialog(start); await answerDialog(dom, '取消'); await pending;
  expect(requests).toHaveLength(1); expect(start.disabled).toBe(false);
  const nonready = plan({ ready: false, count: 0, members: [], reason: '没有可准入的直接来源' });
  globalThis.fetch = async () => Response.json(nonready);
  await start.onclick(); expect(deepText(dom.node('detail'))).toContain(nonready.reason);
});

test('existing active operation is shown rather than restarted; incomplete member list cannot be confirmed', async () => {
  const { start, root, requests } = mount(() => Response.json(plan({ ready: false, active: operation() })));
  await start.onclick(); expect(requests).toHaveLength(1); expect(deepText(root)).toContain('已有整合操作'); expect(start.disabled).toBe(true);
  root.remove(); const second = integrationControl(target); dom.node('detail').append(second);
  globalThis.fetch = async () => Response.json(plan({ count: 2 }));
  await second.querySelector('button').onclick(); expect(deepText(second)).toContain('来源清单不完整'); expect(dom.node('modal').querySelector('.modal-confirm')).toBeNull();
});

test('start ACK followed by refresh failure preserves operation and cannot resend the mutation', async () => {
  let writes = 0;
  const { start, root } = mount((_, options) => options?.method === 'POST' ? (writes++, Response.json(operation())) : Response.json(plan()), async () => { throw Error('offline refresh'); });
  const { pending } = await startDialog(start); await answerDialog(dom, '开始整合'); await pending;
  expect(deepText(root)).toContain('请求已确认，但页面刷新失败'); expect(deepText(root)).toContain('不要重复开始');
  await start.onclick(); expect(writes).toBe(1); expect(start.disabled).toBe(true);
});

test('late preflight after page/project switch never starts an operation', async () => {
  const response = gate();
  const { start, requests } = mount(() => response.promise);
  const pending = start.onclick(); ui.view = { id: 'other' }; dom.location.pathname = '/p/bbbbbbbbbbbbbbbb/';
  response.resolve(Response.json(plan())); await pending;
  expect(requests).toHaveLength(1); expect(dom.node('modal').querySelector('.modal-confirm')).toBeNull();
});

test('confirmation belonging to a detached target cannot submit; an active operation from another target is rejected', async () => {
  const { root, start, requests } = mount(() => Response.json(plan()));
  const { pending } = await startDialog(start); root.remove();
  await answerDialog(dom, '开始整合'); await pending;
  expect(requests).toHaveLength(1);
  globalThis.fetch = async () => Response.json(plan({ active: operation({ target_branch: 'unrelated' }) }));
  const next = integrationControl(target); dom.node('detail').append(next); await next.querySelector('button').onclick();
  expect(deepText(next)).toContain('目标不匹配'); expect(next.querySelector('.integration-summary')).toBeNull();
});

test('bounded sources and advanced evidence stay distinct; explicit full read shows every source', async () => {
  dom = installDom({ fetch: () => Response.json(operation({ members: [...members, { ...members[0], id: 4, worker_number: 'W7' }], member_count: 2, members_truncated: false })) });
  ui.view = { id: 'task' };
  const root = integrationDetails({ id: 9, task_kind: 'integration', merge_operation: operation({ member_count: 2, members_truncated: true }) }); dom.node('detail').append(root);
  expect(deepText(root)).toContain('1 / 2'); expect(root.querySelector('details').open).not.toBe(true);
  await root.querySelectorAll('button').find(node => node.textContent === '读取完整来源与状态').onclick();
  expect(root.querySelector('.integration-sources').children).toHaveLength(2); expect(deepText(root)).toContain('W7');
  expect(root.querySelector('details').open).not.toBe(true);
});

test('retry/cancel use exact operation revision; unknown response blocks mutation until a read', async () => {
  let writes = 0;
  dom = installDom({ fetch: (_, options) => options?.method === 'POST' ? (writes++, Response.json({ error: 'lost ACK' }, { status: 503 })) : Response.json(operation({ state: 'failed', worker: { id: 9, status: 'failed' } })) });
  ui.view = { id: 'task' };
  const root = integrationDetails({ id: 9, task_kind: 'integration', merge_operation: operation({ state: 'failed', worker: { id: 9, status: 'failed' } }) }); dom.node('detail').append(root);
  const retry = root.querySelectorAll('button').find(node => node.textContent === '重试整合');
  expect(retry.classList.contains('agent-call')).toBe(true);
  const pending = retry.onclick(); await answerDialog(dom, '重试整合'); await pending;
  expect(writes).toBe(1); expect(JSON.parse(dom.requests.find(row => row.options?.method === 'POST').options.body)).toEqual({ method: 'branch.integrate_retry', params: { id: 10, expected_revision: 'operation-rev' } });
  expect(root.querySelectorAll('button').find(node => node.textContent === '重试整合').disabled).toBe(true);
  await root.querySelectorAll('button').find(node => node.textContent === '刷新整合状态').onclick();
  const cancel = root.querySelectorAll('button').find(node => node.textContent === '取消本次整合');
  expect(cancel.disabled).toBe(false); expect(cancel.classList.contains('agent-call')).toBe(false);
});

test('unknown landing has no retry/cancel, and historical success does not claim new source work was merged', () => {
  dom = installDom({ fetch: () => Response.json({}) }); ui.view = { id: 'task' };
  const blocked = integrationDetails({ task_kind: 'integration', merge_operation: operation({ state: 'blocked', error: '精确收据待核查' }) });
  dom.node('detail').append(blocked);
  expect(deepText(blocked)).toContain('落地结果需核查'); expect(blocked.querySelectorAll('button').map(node => node.textContent)).toEqual(['刷新整合状态']);
  const summary = integrationSummary({ id: 2, integration: 'pending', merge_operation: operation({ state: 'integrated', commit: sha }) });
  expect(deepText(summary)).toContain('上次整合 · 已合并');
});
