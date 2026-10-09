import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText, answerDialog, dialogText } from '../dom-stub.js';
import { until } from '../helpers.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld();
let graph, messageResult, rejectMessage = false;
const calls = [];
const json = value => ({ ok: true, json: async () => value });
const dom = installDom({ fetch: (url, options = {}) => {
  if (String(url).startsWith('/api/worker-graph')) return json(graph);
  if (String(url).endsWith('/api/action')) {
    const call = JSON.parse(options.body);
    if (call.method === 'worker.message') {
      calls.push(call);
      if (rejectMessage) { rejectMessage = false; return { ok: false, json: async () => ({ error: '暂时无法提交' }) }; }
      return json(messageResult);
    }
  }
  return world.fetchImpl(url, options);
} });
const { resetUiState, ui } = await import('../../src/ui/web/assets/state.js');
const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
const { renderTaskGraph } = await import('../../src/ui/web/assets/render-task-graph.js');
const { appendInputBlocker, inputQueue, appendInputAcknowledgement } = await import('../../src/ui/web/assets/worker-input.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const { resetPrefs } = await import('../../src/ui/web/assets/prefs.js');
const task = { id: 297, worker_number: 'W153', parent_id: 1, role: 'agent', task_kind: 'order',
  goal: '冻结期间也可以追加', title: '冻结期间也可以追加', branch: 'lush/297', workspace: '/tmp/297',
  target_branch: 'main', status: 'waiting', integration: 'pending', children: [], deps: [], dependents: [] };
const buttonOf = (root, label) => [...root.querySelectorAll('button')].find(button => button.textContent === label);
beforeEach(() => {
  resetUiState(); resetPrefs(); closeDialog(); dom.node('modal').hidden = true;
  dom.node('detail').replaceChildren(); document.activeElement = null; calls.length = 0;
  graph = { total: 1, nodes: [task], edges: [] };
  messageResult = { ...task, input_queue: { buffered: 2, reason: '等待固定交付结束' } }; rejectMessage = false;
});
afterAll(() => { closeDialog(); dom.restore(); });

function paintGraph(row, minimal = false, parents = []) {
  dom.node('detail').replaceChildren(); document.activeElement = null;
  ui.view = { id: 'task-graph' }; ui.taskGraphMinimal = minimal;
  graph = { total: 1 + parents.length, nodes: [...parents, row], edges: [] };
  renderTaskGraph(graph);
  const card = dom.node('detail').querySelector('[data-task-id="297"]');
  if (minimal) card.querySelector('.task-graph-more-trigger').onclick();
  return card;
}

test('追加准入不继承分支写冻结，终态／归档／类型／已知祖先边界仍保留', () => {
  for (const status of ['requested', 'executing', 'resolving', 'blocked'])
    expect(appendInputBlocker({ ...task, reservation: { status }, freeze: {} })).toBeNull();
  expect(appendInputBlocker({ ...task, status: 'paused' })).toBeNull();
  for (const change of [{ status: 'completed' }, { status: 'failed' }, { status: 'cancelled' }, { task_kind: 'main' },
    { task_kind: 'owner' }, { task_kind: 'management' }, { archived: true }, { branch_info: { archived: true } },
    { branch_archive: { archived: true } }, { branch: null }, { workspace_state: 'missing' }])
    expect(appendInputBlocker({ ...task, ...change })).toBeTruthy();
  expect(appendInputBlocker(task, [{ id: 1, status: 'completed', task_kind: 'order', worker_number: 'W12' }])).toContain('W12');
  expect(appendInputBlocker(task, [])).toBeNull(); // Missing ancestors are not inferred from a partial graph.
});

test('安全投影只认可真实条数，缺字段／错误字段不伪造投递事实', () => {
  for (const value of [undefined, { buffered: -1, reason: null }, { buffered: 1.5, reason: null },
    { buffered: '3', reason: null }, { buffered: 3, reason: {} }])
    expect(inputQueue({ input_queue: value })).toBeNull();
  const frozen = { ...task, reservation: { status: 'requested' } };
  expect(appendInputAcknowledgement(frozen, {})).toContain('投递状态暂不可用');
  expect(appendInputAcknowledgement(task, { input_queue: { buffered: 0, reason: null } })).toContain('可接收输入时处理');
  expect(appendInputAcknowledgement(task, messageResult)).toContain('已保存给 Worker W153，等待投递');
});

test('详情和两种图模式保留冻结追加入口，明确显示暂存条数和原因且不开放同步', () => {
  for (const status of ['requested', 'executing', 'resolving', 'blocked']) {
    const row = { ...task, reservation: { version: 2, kind: 'merge', status }, freeze: { reason: '固定交付中' },
      input_queue: { buffered: 2, reason: '等待固定交付结束' } };
    renderDetail(row, null, null, null);
    const panel = dom.node('detail'), append = buttonOf(panel, '向该 Worker 追加输入');
    expect(append.disabled).not.toBe(true);
    expect(append.classList.contains('agent-call')).toBe(false); // Mode selection does not invoke an Agent.
    expect(append.getAttribute('data-help')).toContain('解除冻结且 Agent 静息');
    expect(panel.querySelector('.worker-input-queue').textContent).toContain('已暂存 2 条追加输入');
    expect(panel.querySelector('.worker-input-queue').textContent).toContain('等待固定交付结束');
    expect(buttonOf(panel, '同步父分支').disabled).toBe(true);
    for (const minimal of [false, true]) {
      const card = paintGraph(row, minimal), send = buttonOf(card, '向此 Worker 输入');
      expect(send.disabled).not.toBe(true); expect(send.classList.contains('agent-call')).toBe(true);
      expect(send.getAttribute('data-help')).toContain('不打断在途交付或源侧修复');
      expect(deepText(card)).toContain(minimal ? '暂存输入 2 条' : '已暂存 2 条追加输入');
      expect(deepText(card)).toContain('等待固定交付结束');
      expect(buttonOf(card, '同步父分支').disabled).toBe(true);
    }
  }
});

test('冻结追加可见不放开归档或已关闭祖先的追加入口', () => {
  renderDetail({ ...task, archived: true }, null, null, null);
  const append = buttonOf(dom.node('detail'), '向该 Worker 追加输入');
  expect(append.disabled).toBe(true); expect(append.parentNode.getAttribute('data-help')).toContain('归档');
  const parent = { id: 1, worker_number: 'W12', task_kind: 'order', role: 'agent', status: 'completed', title: '已验收', branch: 'lush/1' };
  for (const minimal of [false, true]) {
    const card = paintGraph(task, minimal, [parent]);
    const send = buttonOf(card, '向此 Worker 输入');
    expect(send.disabled).toBe(true); expect(send.parentNode.getAttribute('data-help')).toContain('W12');
  }
});

test('图追加失败重开输入框保留正文，成功确认保存但不冒充 Agent 已收到', async () => {
  const card = paintGraph({ ...task, reservation: { status: 'resolving' }, input_queue: { buffered: 1, reason: '等待修复结束' } });
  rejectMessage = true;
  const sending = buttonOf(card, '向此 Worker 输入').onclick();
  expect(dialogText(dom)).toContain('已暂存 1 条追加输入');
  await answerDialog(dom, '发送消息', '保住这条需求');
  await until(() => dialogText(dom).includes('正文已保留'));
  expect(dom.node('modal').querySelector('input').value).toBe('保住这条需求');
  expect(calls).toHaveLength(1);
  await answerDialog(dom, '发送消息', '修正后的需求'); await sending;
  expect(calls).toHaveLength(2); expect(calls.at(-1).params.body).toBe('修正后的需求');
  expect(dom.node('error').textContent).toContain('已保存给 Worker W153，等待投递');
  expect(dom.node('modal').hidden).toBe(true);
});

test('旧服务缺队列字段不展示虚构计数，图追加确认仅承诺持久保存', async () => {
  messageResult = { ...task };
  const card = paintGraph({ ...task, freeze: {} });
  expect(card.querySelector('.worker-input-queue')).toBeNull();
  const sending = buttonOf(card, '向此 Worker 输入').onclick();
  await answerDialog(dom, '发送消息', '继续'); await sending;
  expect(dom.node('error').textContent).toContain('投递状态暂不可用');
  expect(dom.node('error').textContent).not.toContain('已投递');
});
