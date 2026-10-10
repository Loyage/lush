import { test, expect, afterAll } from 'bun:test';
import { installDom, dialogText, answerDialog } from './project-dom.js';
import { makeWorld } from './dom-world.js';

/** 独立 world：main 下一条静息待合并、一条还在跑，用来验证「合并所有」的候选口径与调用。 */
const world = makeWorld();
world.state.devicePreferences.values.taskGraphMinimal = false;
const graph = { nodes: [
  { id: 1, parent_id: null, task_kind: 'main', role: 'agent', status: 'waiting', title: 'main', branch: 'main', children: [] },
  { id: 2, parent_id: 1, task_kind: 'order', role: 'agent', status: 'waiting', title: '实现功能', branch: 'lush/task-2',
    workspace: '/tmp/task-2', target_branch: 'main', integration: 'pending', children: [] },
  { id: 3, parent_id: 1, task_kind: 'order', role: 'agent', status: 'running', title: '还在跑', branch: 'lush/task-3',
    workspace: '/tmp/task-3', target_branch: 'main', integration: 'pending', children: [] },
  { id: 4, parent_id: 1, task_kind: 'order', role: 'agent', status: 'waiting', title: '目标在别处', branch: 'lush/task-4',
    workspace: '/tmp/task-4', target_branch: 'release', integration: 'pending', children: [] },
], total: 4, truncated: false };
const dom = installDom({ fetch: (url, options) => {
  if (String(url).split('?')[0] === '/api/worker-graph') return { ok: true, json: async () => graph };
  return world.fetchImpl(url, options);
} });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { setPref } = await import('../../src/ui/web/assets/prefs.js');
setPref('taskGraphMinimal', false); // 验证详情模式中的就地操作。
await boot();
afterAll(() => dom.restore());

test('main 分支给「合并所有」入口：只计静息待合并 Task，确认后一次调用 worker.reserve_all', async () => {
  await dom.node('task-graph-open').onclick();
  const mainCard = dom.node('detail').querySelector('[data-task-id="1"]');
  const mergeAll = mainCard.querySelectorAll('button').find(node => node.textContent.startsWith('合并所有'));
  expect(mergeAll).toBeTruthy();
  expect(mergeAll.textContent).toBe('合并所有（1）');
  expect(mergeAll.classList.contains('agent-call')).toBe(true);
  expect(mergeAll.getAttribute('data-help')).toContain('消耗 token');

  const pending = mergeAll.onclick();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(dialogText(dom)).toContain('一并放入父交付队列');
  expect(dialogText(dom)).toContain('父 Worker 自有队列的 runtime');
  expect(dialogText(dom)).toContain('不创建 merge Worker、不改变父子关系');
  expect(dialogText(dom)).toContain('不额外调用父 Agent');
  expect(dialogText(dom)).toContain('按入队顺序排队（代码依赖优先）');
  expect(dialogText(dom)).toContain('修复期间保留父执行位');
  expect(dialogText(dom)).toContain('恢复重新排队并固定新基线');
  expect(dialogText(dom)).toContain('#2 实现功能');
  expect(dialogText(dom)).not.toContain('#3');
  await answerDialog(dom, '开始合并');
  await pending;
  expect(world.state.actions.at(-1)).toEqual({ method: 'worker.reserve_all', params: { branch: 'main' } });
});

test('没有候选时按钮保留但禁用，并用 help-host 写明原因', async () => {
  const saved = graph.nodes[1].integration;
  graph.nodes[1].integration = 'merged';
  try {
    await dom.node('task-graph-open').onclick();
    const mainCard = dom.node('detail').querySelector('[data-task-id="1"]');
    const disabled = mainCard.querySelectorAll('button').find(node => node.textContent === '合并所有');
    expect(disabled).toBeTruthy();
    expect(disabled.disabled).toBe(true);
    expect(disabled.parentNode.className).toContain('help-host');
    expect(disabled.parentNode.getAttribute('data-help')).toContain('没有已静息');
  } finally {
    graph.nodes[1].integration = saved;
  }
});
