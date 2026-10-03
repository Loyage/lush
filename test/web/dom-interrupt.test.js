import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText, dialogText, answerDialog } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld();
const calls = [];
let rejectMethod = null;
const dom = installDom({ fetch: async (url, options) => {
  if (String(url).endsWith('/api/action')) {
    const request = JSON.parse(options.body);
    calls.push(request);
    if (request.method === rejectMethod) return new Response(JSON.stringify({ error: '状态已变化' }), { status: 409 });
    return new Response(JSON.stringify({ status: request.method === 'worker.interrupt' ? 'running' : 'queued' }));
  }
  return world.fetchImpl(url, options);
} });
const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
const { renderTree } = await import('../../src/ui/web/assets/render-tree.js');
const { renderHistory } = await import('../../src/ui/web/assets/render-history.js');
const { renderTaskGraph } = await import('../../src/ui/web/assets/render-task-graph.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const { resetUiState, ui } = await import('../../src/ui/web/assets/state.js');
const { resetPrefs, setPref } = await import('../../src/ui/web/assets/prefs.js');
const { clear, setTimers } = await import('../../src/ui/web/assets/messages.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const { AGENT_NOTE } = await import('../../src/ui/web/assets/help.js');
let refreshed = [];
const restoreNavigation = registerNavigation({ refresh: async () => {}, detail: async id => { refreshed.push(id); }, overview: async () => {} });
setTimers({ setTimeout: () => 1, clearTimeout: () => {}, now: () => 0 });
const task = { id: 70, task_kind: 'say', role: 'agent', status: 'running', interrupt_state: null,
  parent_id: 1, goal: '可撤销中断', title: '可撤销中断', branch: 'feature/interrupt', target_branch: 'main',
  agent_wakes: 1, calls: 0, children: [], deps: [], dependents: [], integration: 'none' };
const buttonOf = label => dom.node('detail').querySelectorAll('button').find(node => node.textContent === label);
const paint = row => renderDetail(row, null, null, null);
beforeEach(() => { resetUiState(); resetPrefs(); clear(); closeDialog(); calls.length = 0; refreshed = []; rejectMethod = null; document.activeElement = null; });
afterAll(() => { closeDialog(); clear(); setTimers(); restoreNavigation(); dom.restore(); });

test('中断保留确认框，取消不请求，成功只说明请求已接受而非已停止', async () => {
  paint(task);
  expect(buttonOf('继续')).toBeUndefined();
  let pending = buttonOf('中断').onclick();
  expect(dialogText(dom)).toContain('中断 Worker #70？');
  expect(dialogText(dom)).toContain('Pi 会等本轮工具结束');
  expect(dialogText(dom)).toContain('其他后端等当前调用自然结束');
  expect(dialogText(dom)).toContain('不会因中断等待超时而强杀');
  expect(calls).toEqual([]);
  await answerDialog(dom, '保留'); await pending;
  expect(calls).toEqual([]);
  pending = buttonOf('中断').onclick();
  await answerDialog(dom, '中断'); await pending;
  expect(calls).toEqual([{ method: 'worker.interrupt', params: { id: 70 } }]);
  expect(dom.node('error').textContent).toContain('中断请求已接受');
  expect(dom.node('error').textContent).not.toContain('已中断');
  expect(refreshed).toEqual([70]);
});

test('requested 不论仍 running 或 awaiting 都可立即继续，保持 Agent 标识和暂停相关入口', async () => {
  for (const status of ['running', 'awaiting']) {
    paint({ ...task, status, interrupt_state: 'requested' });
    expect(deepText(dom.node('detail').querySelector('.head'))).toContain('中断请求中');
    expect(deepText(dom.node('detail').querySelector('.head'))).not.toContain('已暂停');
    expect(buttonOf('中断')).toBeUndefined();
    expect(buttonOf('调整运行设置')).toBeTruthy();
    expect(buttonOf('放弃 Worker')).toBeTruthy();
    const resume = buttonOf('继续');
    expect(resume.disabled).not.toBe(true);
    expect(resume.classList.contains('agent-call')).toBe(true);
    expect(resume.getAttribute('data-help')).toContain(AGENT_NOTE);
    expect(resume.getAttribute('data-help')).toContain('撤销');
    expect(dom.node('detail').querySelector('.interrupt-reason').textContent).toContain('等当前调用到安全点');
    await resume.onclick();
    expect(calls.at(-1)).toEqual({ method: 'worker.resume', params: { id: 70 } });
    expect(dom.node('error').textContent).toContain('继续请求已接受');
    expect(dom.node('error').textContent).not.toContain('已继续运行');
  }
});

test('resuming 明示旧调用释放屏障而非无空槽，重复继续始终可用', async () => {
  paint({ ...task, status: 'queued', interrupt_state: 'resuming' });
  expect(deepText(dom.node('detail').querySelector('.head'))).toContain('继续排队中');
  expect(dom.node('detail').querySelector('.interrupt-reason').textContent).toContain('等旧调用释放后调度');
  const resume = buttonOf('继续');
  await resume.onclick(); await resume.onclick();
  expect(calls).toEqual([
    { method: 'worker.resume', params: { id: 70 } }, { method: 'worker.resume', params: { id: 70 } },
  ]);
  expect(refreshed).toEqual([70, 70]);
  expect(dom.node('error').textContent).not.toContain('已继续运行');
});

test('已暂停与待开始沿用继续/开始，不把入队请求误报为已经运行', async () => {
  for (const agent_wakes of [0, 1]) {
    paint({ ...task, status: 'paused', agent_wakes });
    const label = agent_wakes ? '继续' : '开始';
    expect(buttonOf(label).classList.contains('agent-call')).toBe(true);
    await buttonOf(label).onclick();
    expect(dom.node('error').textContent).toContain(`${label}请求已接受`);
    expect(dom.node('error').textContent).not.toContain('已开始运行');
    expect(dom.node('error').textContent).not.toContain('已继续运行');
  }
});

test('请求中断期间放弃仍须原危险确认，取消不会强杀或放弃', async () => {
  paint({ ...task, task_kind: 'child', interrupt_state: 'requested' });
  let pending = buttonOf('放弃 Worker').onclick();
  expect(dialogText(dom)).toContain('放弃这个 Worker 树？');
  expect(dialogText(dom)).toContain('所有子 Worker');
  expect(dialogText(dom)).toContain('不能直接恢复');
  expect(dom.node('modal').querySelectorAll('button').find(node => node.textContent === '放弃 Worker').classList.contains('danger')).toBe(true);
  await answerDialog(dom, '保留'); await pending;
  expect(calls).toEqual([]);
  pending = buttonOf('放弃 Worker').onclick();
  await answerDialog(dom, '放弃 Worker'); await pending;
  expect(calls).toEqual([{ method: 'worker.cancel', params: { id: 70 } }]);
});

test('继续被拒绝时如实报错、刷新，不显示请求成功', async () => {
  rejectMethod = 'worker.resume';
  paint({ ...task, interrupt_state: 'requested' });
  await buttonOf('继续').onclick();
  expect(dom.node('error').textContent).toContain('无法继续：状态已变化');
  expect(dom.node('error').textContent).not.toContain('请求已接受');
  expect(refreshed).toEqual([70]);
});

test('列表按 interrupt_state 解释等待，不把中断请求当暂停、继续屏障当缺并发槽', () => {
  renderTree({ tasks: [
    { ...task, interrupt_state: 'requested' },
    { ...task, id: 71, status: 'queued', interrupt_state: 'resuming' },
  ], status: { concurrency: 2 }, notices: [] });
  const requested = dom.node('tasks').querySelector('[data-id="70"]');
  expect(deepText(requested)).toContain('中断请求中');
  expect(deepText(requested)).toContain('现在点「继续」可撤销');
  expect(requested.classList.contains('s-running')).toBe(true);
  const resuming = dom.node('tasks').querySelector('[data-id="71"]');
  expect(deepText(resuming)).toContain('继续排队中');
  expect(deepText(resuming)).toContain('等旧调用释放后调度');
  expect(deepText(resuming)).not.toContain('没有空槽');
});

test('完整及极简 Worker 图同步解释请求状态，着色和筛选仍使用真实 status', () => {
  ui.view = { id: 'task-graph' };
  for (const minimal of [false, true]) {
    setPref('taskGraphMinimal', minimal);
    ui.taskGraphMinimal = minimal;
    renderTaskGraph({ total: 2, nodes: [
      { ...task, interrupt_state: 'requested', waiting_reason: '旧等待原因' },
      { ...task, id: 71, status: 'queued', interrupt_state: 'resuming', waiting_reason: '没有空槽' },
    ] });
    const requested = dom.node('detail').querySelector('[data-task-id="70"]');
    const resuming = dom.node('detail').querySelector('[data-task-id="71"]');
    expect(deepText(requested)).toContain('中断请求中');
    expect(deepText(requested)).toContain('现在点「继续」可撤销');
    expect(deepText(requested)).not.toContain('旧等待原因');
    expect(requested.classList.contains('task-graph-running')).toBe(true);
    expect(deepText(resuming)).toContain('继续排队中');
    expect(deepText(resuming)).toContain('等旧调用释放后调度');
    expect(deepText(resuming)).not.toContain('没有空槽');
    expect(resuming.classList.contains('task-graph-queued')).toBe(true);
    expect(dom.node('detail').querySelector('[data-status="running"]')).toBeTruthy();
    expect(dom.node('detail').querySelector('[data-status="queued"]')).toBeTruthy();
    document.activeElement = null;
  }
});

test('中断和恢复事件标题只承诺请求被接受，不冒称旧调用已经停止或重新运行', () => {
  const history = renderHistory([
    { id: 1, type: 'task.interrupted', data: { pending: true } },
    { id: 2, type: 'task.resumed', data: { pending_exit: true } },
  ], { taskId: task.id });
  expect(deepText(history)).toContain('接受中断请求');
  expect(deepText(history)).toContain('接受继续请求');
  expect(deepText(history)).not.toContain('已中断');
  expect(deepText(history)).not.toContain('继续运行');
  expect(deepText(renderHistory([{ id: 3, type: 'task.paused', data: {} }], { taskId: task.id })))
    .toContain('已安全暂停');
});

test('终态、历史只读记录不因陈旧 interrupt_state 重新开放继续操作', () => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    paint({ ...task, status, interrupt_state: 'requested' });
    expect(buttonOf('继续')).toBeUndefined();
    expect(dom.node('detail').querySelector('.interrupt-reason')).toBeNull();
  }
  paint({ ...task, role: 'showcase', interrupt_state: 'requested' });
  expect(buttonOf('继续')).toBeUndefined();
  expect(buttonOf('中断')).toBeUndefined();
});
