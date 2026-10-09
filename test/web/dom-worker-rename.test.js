import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText, answerDialog, dialogText } from '../dom-stub.js';
import { until } from '../helpers.js';

let graph, rejectSave, rejectRead;
const calls = [];
const json = value => ({ ok: true, json: async () => value });
const dom = installDom({ fetch: (url, options = {}) => {
  if (String(url).startsWith('/api/worker-graph')) return rejectRead
    ? { ok: false, json: async () => ({ error: 'refresh unavailable' }) } : json(graph);
  if (String(url).endsWith('/api/action')) {
    const call = JSON.parse(options.body); calls.push(call);
    if (rejectSave) { rejectSave = false; return { ok: false, json: async () => ({ error: 'title too long' }) }; }
    const display_title = call.params.title.trim() || null;
    graph = { ...graph, nodes: graph.nodes.map(row => row.id === call.params.id
      ? { ...row, display_title, title: display_title || '自动标题' } : row) };
    return json({ id: call.params.id, display_title });
  }
  return json({});
} });
const { resetUiState, ui } = await import('../../src/ui/web/assets/state.js');
const { resetPrefs } = await import('../../src/ui/web/assets/prefs.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const { renderTaskGraph } = await import('../../src/ui/web/assets/render-task-graph.js');
const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
const { renderTree } = await import('../../src/ui/web/assets/render-tree.js');
const { workerRenameControl } = await import('../../src/ui/web/assets/worker-rename.js');
const { taskTitle } = await import('../../src/ui/web/assets/format.js');
const { filterTasks } = await import('../../src/ui/web/assets/sidebar.js');
const task = { id: 302, worker_number: 'W156', role: 'agent', task_kind: 'order', parent_id: null,
  title: '自动标题', display_title: null, goal: '自动标题\n原始执行正文', status: 'running', integration: 'none',
  children: [], deps: [], dependents: [] };
const buttonOf = (root, label) => [...root.querySelectorAll('button')].find(button => button.textContent === label);
beforeEach(() => {
  resetUiState(); resetPrefs(); closeDialog(); dom.node('modal').hidden = true;
  dom.node('detail').replaceChildren(); dom.node('error').textContent = ''; document.activeElement = null; calls.length = 0;
  rejectSave = rejectRead = false; dom.location.pathname = '/';
  graph = { total: 1, nodes: [{ ...task }], edges: [] };
});
afterAll(() => { closeDialog(); dom.restore(); });
function paint(minimal = true, change = {}) {
  ui.view = { id: 'task-graph' }; ui.taskGraphMinimal = minimal;
  graph.nodes[0] = { ...graph.nodes[0], ...change };
  renderTaskGraph(graph);
  const card = dom.node('detail').querySelector('[data-task-id="302"]');
  const more = card.querySelector('.task-graph-more-trigger'); more.focus(); more.onclick();
  return card;
}

test('both tree modes expose rename in ⋯ for running, frozen, terminal and archived Workers without Agent markings', () => {
  for (const minimal of [true, false]) for (const change of [{}, { status: 'completed' },
    { reservation: { version: 2, kind: 'merge', status: 'executing' } }, { archived: true }]) {
    dom.node('detail').replaceChildren(); ui.taskGraphShowArchived = true;
    const control = buttonOf(paint(minimal, change), '重命名');
    expect(control).toBeTruthy(); expect(control.disabled).not.toBe(true);
    expect(control.classList.contains('agent-call')).toBe(false);
    expect(control.getAttribute('data-help')).toContain('不改变任务正文');
  }
  renderDetail({ ...task, display_title: '详情标题' }, null, null, null);
  expect(dom.node('detail').querySelector('h1').textContent).toBe('详情标题');
  expect(buttonOf(dom.node('detail'), '重命名')).toBeTruthy(); expect(calls).toHaveLength(0);
});

test('tree rename saves custom text, refreshes title and retains Worker identity and original body', async () => {
  const card = paint();
  const saving = buttonOf(card, '重命名').onclick();
  expect(dialogText(dom)).toContain('不调用 Agent'); expect(dialogText(dom)).toContain('W156');
  expect(dom.node('modal').querySelector('input').value).toBe('自动标题');
  expect(buttonOf(dom.node('modal'), '保存').classList.contains('agent-call')).toBe(false);
  answerDialog(dom, '保存', '  登录修复 <img onerror=alert(1)>  '); await saving;
  expect(calls).toEqual([{ method: 'worker.rename', params: { id: 302, title: '  登录修复 <img onerror=alert(1)>  ' } }]);
  expect(deepText(dom.node('detail'))).toContain('W156 登录修复 <img onerror=alert(1)>');
  expect(dom.node('detail').querySelector('img')).toBeNull();
  expect(graph.nodes[0].goal).toBe(task.goal); expect(graph.nodes[0].status).toBe('running');
  expect(dom.node('error').textContent).toContain('已保存');
});

test('cancel is no-op, empty title restores default, and repeated opening uses saved title', async () => {
  const card = paint(true, { display_title: '已有标题', title: '已有标题' });
  let saving = buttonOf(card, '重命名').onclick();
  expect(dom.node('modal').querySelector('input').value).toBe('已有标题'); answerDialog(dom, '取消'); await saving;
  expect(calls).toHaveLength(0);
  saving = buttonOf(card, '重命名').onclick(); answerDialog(dom, '保存', ''); await saving;
  expect(calls[0].params.title).toBe(''); expect(deepText(dom.node('detail'))).toContain('W156 自动标题');
});

test('save failure retains input for retry; refresh failure is not mislabeled as an unsaved title', async () => {
  rejectSave = true;
  const saving = buttonOf(paint(), '重命名').onclick();
  answerDialog(dom, '保存', '保留我的标题'); await until(() => dialogText(dom).includes('保存失败'));
  expect(dom.node('modal').querySelector('input').value).toBe('保留我的标题');
  expect(dialogText(dom)).toContain('title too long');
  rejectRead = true; answerDialog(dom, '保存', '修正后的标题'); await saving;
  expect(calls).toHaveLength(2); expect(graph.nodes[0].display_title).toBe('修正后的标题');
  expect(dom.node('modal').hidden).toBe(true);
  expect(dom.node('error').textContent).toContain('标题已保存，但页面更新失败');
});

test('navigation or project changes while editing prevent a stale submission; duplicate click does not open a second dialog', async () => {
  const control = buttonOf(paint(), '重命名');
  const saving = control.onclick(); await control.onclick();
  ui.view = { id: 'overview' }; answerDialog(dom, '保存', '不要保存'); await saving;
  expect(calls).toHaveLength(0);
  const savingProject = workerRenameControl(task).onclick();
  dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/'; answerDialog(dom, '保存', '另一个项目'); await savingProject;
  expect(calls).toHaveLength(0);
});

test('custom titles render in lists and are searchable without losing original-goal search or fallback', () => {
  const row = { ...task, display_title: '容易回忆的功能' };
  expect(taskTitle(row)).toBe(row.display_title); expect(taskTitle(task)).toBe('自动标题');
  for (const text of ['容易回忆', '原始执行正文', 'W156']) expect(filterTasks([row], { text })).toEqual([row]);
  renderTree({ tasks: [row], notices: [], status: { concurrency: 1 } });
  expect(deepText(dom.node('tasks'))).toContain(row.display_title);
});
