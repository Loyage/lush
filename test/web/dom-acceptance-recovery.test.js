import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { iterationBlocker, iterationControls } from '../../src/ui/web/assets/render-iteration.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';
import { renderTaskGraph } from '../../src/ui/web/assets/render-task-graph.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';
import { ui } from '../../src/ui/web/assets/state.js';

let dom, requests, restore, refusal;
const task = { id: 70, worker_number: 'W169', parent_id: 1, task_kind: 'order', role: 'agent',
  goal: '部分回收现场', status: 'awaiting_acceptance', integration: 'merged', branch: 'feature/recovery', target_branch: 'main',
  workspace: null, workspace_state: 'missing', archived: true, accepted: false, acceptance_recovery: true,
  branch_archive: { archived: true, archivable: false }, branch_info: { archived: true, archivable: false },
  reservation: { version: 2, kind: 'merge', status: 'integrated' }, children: [], deps: [], dependents: [], calls: 1 };
const btn = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const root = () => dom.node('detail');
beforeEach(() => {
  requests = []; refusal = null;
  dom = installDom({ fetch: async (_url, options) => {
    if (options?.body) requests.push(JSON.parse(options.body));
    if (refusal) return new Response(JSON.stringify({ error: refusal }), { status: 409 });
    return new Response(JSON.stringify({ ...task, status: 'completed', workspace: null, acceptance_recovery: false }));
  } });
  restore = registerNavigation({ refresh: async () => {}, detail: async () => {} });
  ui.lastSnapshot = null; ui.taskGraphShowArchived = false; ui.taskGraphMinimal = false;
  activateDetailView({ view: 'task', key: 'task-70' });
});
afterEach(() => { restore(); dom.restore(); });

function graph(row, minimal = false) {
  ui.taskGraphMinimal = minimal; activateDetailView({ view: 'task-graph' });
  renderTaskGraph({ total: 1, nodes: [row], edges: [] });
  const node = root().querySelector('[data-task-id="70"]');
  if (minimal && node) node.querySelector('.task-graph-more-trigger').onclick();
  return node;
}

test('audited incomplete acceptance stays visible after root archival in detail and both graph modes', async () => {
  for (const view of ['detail', 'graph', 'minimal-graph']) {
    root().replaceChildren(); requests.length = 0;
    if (view === 'detail') renderDetail(task, { events: [] }, null, null);
    else expect(graph(task, view === 'minimal-graph')).toBeTruthy();
    const resume = btn(root(), '续办验收');
    expect(resume).toBeTruthy(); expect(resume.disabled).toBe(false);
    expect(resume.classList.contains('agent-call')).toBe(false);
    expect(btn(root(), '清理资源')).toBeUndefined(); expect(btn(root(), '同步父分支')).toBeUndefined();
    expect(deepText(root())).toContain('精确续办记录');
    expect(deepText(root())).toContain('已合并 · 验收待续办');
    expect(requests).toHaveLength(0); // A read or rendering must not retry deletion.
    await resume.onclick(); await resume.onclick();
    expect(requests).toEqual([{ method: 'worker.accept', params: { id: 70 } }]);
  }
});

test('completed recovery facts do not need a live workspace or an acceptance event to expose the continuation', () => {
  for (const accepted of [false, true]) {
    const panel = iterationControls({ ...task, status: 'completed', accepted });
    expect(btn(panel, '续办验收').disabled).toBe(false);
  }
});

test('only strict true recovery facts bypass physical reclamation blockers; ordinary operations remain blocked', () => {
  for (const acceptance_recovery of [undefined, false, null, 'true', 1]) {
    const row = { ...task, acceptance_recovery };
    const panel = iterationControls(row);
    expect(btn(panel, '续办验收')).toBeUndefined(); expect(btn(panel, '验收').disabled).toBe(true);
    expect(graph(row)).toBeNull(); // No recovery proof: the normal history filter still applies.
  }
  expect(iterationBlocker(task)).toContain('归档'); // Composer/sync callers cannot use the acceptance exception.
  expect(iterationBlocker(task, { forAcceptance: true })).toBeNull();
});

test('running, queued, frozen, unread descendants and active delivery gates are not relaxed for recovery', () => {
  for (const fields of [{ status: 'running' }, { status: 'queued' }, { status: 'paused' },
    { agent: { active: true } }, { freeze: { reason: '父队列仍占用' } },
    { branch_archive: { archived: true, freeze: {} } },
    { children: [{ id: 71, status: 'awaiting_acceptance' }] },
    ...['pending', 'requested', 'executing', 'resolving', 'blocked', 'suspended'].map(status => ({ reservation: { kind: 'merge', status } }))]) {
    const panel = iterationControls({ ...task, ...fields }), resume = btn(panel, '续办验收');
    expect(resume.disabled).toBe(true); expect(resume.parentNode.classList.contains('help-host')).toBe(true);
    expect(resume.parentNode.getAttribute('data-help').length).toBeGreaterThan(10);
  }
  for (const status of ['failed', 'cancelled']) expect(iterationControls({ ...task, status })).toBeNull();
});

test('a settled root cannot be mistaken for successful acceptance while audited recovery is still pending', () => {
  renderDetail({ ...task, status: 'completed', accepted: true }, { events: [{ type: 'task.accepted' }] }, null, null);
  expect(deepText(root())).toContain('验收待续办');
  expect(btn(root(), '续办验收')).toBeTruthy(); expect(btn(root(), '继续开发')).toBeUndefined();
});

test('recovery candidate still respects server inbox and decision checks, and explicit retries never use separate deletion', async () => {
  const panel = iterationControls(task); root().replaceChildren(panel);
  const resume = btn(panel, '续办验收');
  for (const reason of ['未读输入阻止验收，请先处理', '待决问题尚未答复', '后代资源尚被使用']) {
    refusal = reason; await resume.onclick();
    expect(dom.node('error').textContent).toContain(reason); expect(resume.disabled).toBe(false);
  }
  refusal = null; await resume.onclick(); await resume.onclick();
  expect(requests).toHaveLength(4); expect(requests.every(call => call.method === 'worker.accept')).toBe(true);
});

test('child recovery remains a direct-parent confirmation, not user acceptance', () => {
  renderDetail({ ...task, task_kind: 'child', parent_worker_number: 'W12' }, null, null, null);
  expect(btn(root(), '验收')).toBeUndefined(); expect(btn(root(), '续办验收')).toBeUndefined();
  expect(deepText(root())).toContain('W12'); expect(deepText(root())).toContain('持久记录续办验收');
});
