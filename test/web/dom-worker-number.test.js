import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';
import { workerNumber, inputNumber, taskTitle, edgeLabel } from '../../src/ui/web/assets/format.js';
import { workerLabel, forgetWorkerLabel } from '../../src/ui/web/assets/worker-label.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';
import { renderTaskGraph } from '../../src/ui/web/assets/render-task-graph.js';
import { renderTree } from '../../src/ui/web/assets/render-tree.js';
import { matchTask } from '../../src/ui/web/assets/sidebar.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';

const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
beforeEach(() => {
  dom.location.pathname = '/';
  resetUiState();
  ui.view = { id: 'task-graph' };
  dom.node('detail').replaceChildren();
  dom.node('tasks').replaceChildren();
});
afterAll(() => dom.restore());

/* ---------- 纯格式化：显式编号才用 Wn，否则保留整数身份 ---------- */

test('workerNumber only accepts the server-projected stable shape; history keeps #id', () => {
  for (const value of ['W5', 'W5-1', 'W5-1-12', 'W123-4-5']) {
    expect(workerNumber({ id: 9, worker_number: value })).toBe(value);
  }
  for (const value of [null, undefined, '', 'W0', 'W', 'w5', '5', 'W5-', 'W5-0', 'W-1', '#5', 'W5-1-']) {
    expect(workerNumber({ id: 9, worker_number: value })).toBe('#9');
  }
  expect(workerNumber({ id: 9 })).toBe('#9');
  expect(workerNumber(null)).toBe('#?');
});

test('inputNumber uses O for emitted inputs only; drafts and empty ids are not O numbers', () => {
  expect(inputNumber(5)).toBe('O5');
  expect(inputNumber(94)).toBe('O94');
  expect(inputNumber(undefined)).toBe('O?');
});

test('taskTitle and edgeLabel prefer the stable number without changing fallbacks', () => {
  expect(taskTitle({ id: 5, worker_number: 'W5', goal: '' })).toBe('Worker W5');
  expect(taskTitle({ id: 5, worker_number: null, goal: '' })).toBe('Worker #5');
  expect(edgeLabel({ id: 5, worker_number: 'W5-1', kind: 'code', status: 'running' })).toContain('W5-1');
  expect(edgeLabel({ id: 5, worker_number: null, kind: 'order', status: 'running' })).toContain('#5');
});

/* ---------- 标签缓存：只记服务端显式编号，跨项目隔离，可删除 ---------- */

test('label cache reuses only explicit metadata, scopes by project and forgets deleted workers', () => {
  dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/';
  expect(workerLabel(7, 'W7')).toBe('W7');
  // Missing projection (old host) still resolves the known label for link-only integers.
  expect(workerLabel(7)).toBe('W7');
  // An explicit null clears the stale label instead of resurrecting it.
  expect(workerLabel({ id: 7, worker_number: null })).toBe('#7');
  expect(workerLabel(7)).toBe('#7');
  workerLabel(8, 'W8');
  forgetWorkerLabel(8);
  expect(workerLabel(8)).toBe('#8');
  workerLabel(7, 'W7');
  // Same integer in another project must not leak the first project's label.
  dom.location.pathname = '/p/bbbbbbbbbbbbbbbb/';
  expect(workerLabel(7)).toBe('#7');
  dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/';
  expect(workerLabel(7)).toBe('W7');
});

/* ---------- Worker 图：自己/深层子 Worker/合并队列都显示编号，点击仍是整数 ---------- */

test('graph cards, deep child and merge-queue links show Wn while navigation keeps integer ids', async () => {
  const empty = () => ({ total: 0, counts: {}, items: [], truncated: false });
  const parent = { id: 5, parent_id: 1, task_kind: 'order', worker_number: 'W5', role: 'agent', status: 'waiting',
    title: '实现编号', target_branch: 'main', merge_queue: { counts: { requested: 1 }, total: 1, truncated: false,
      items: [{ id: 7, worker_number: 'W5-1-1', status: 'requested' }] } };
  const grandchild = { id: 7, parent_id: 5, task_kind: 'child', worker_number: 'W5-1-1', role: 'agent',
    status: 'completed', title: '小改动', merge_queue: empty(), reservation: { version: 2, queue_protocol: 1, kind: 'merge',
      status: 'requested', parent_id: 5, parent_worker_number: 'W5' } };
  const old = { id: 42, parent_id: 5, task_kind: 'child', worker_number: null, role: 'agent', status: 'waiting',
    title: '历史 Worker', merge_queue: empty(), reservation: { version: 2, queue_protocol: 1, kind: 'merge',
      status: 'pending', parent_id: 5 } };
  let opened = null;
  const restore = registerNavigation({ detail: id => { opened = id; } });
  try {
    renderTaskGraph({ total: 3, nodes: [parent, grandchild, old] });
    const card = id => dom.node('detail').querySelector(`[data-task-id="${id}"]`);
    expect(deepText(card(5))).toContain('W5');
    expect(deepText(card(7))).toContain('W5-1-1');
    expect(deepText(card(42))).toContain('#42');
    // Merge queue link lists the child by stable number; the same integer target reaches detail().
    const queueLink = card(5).querySelector('[data-graph-focus="merge-child-5-7"]');
    expect(queueLink.textContent).toBe('W5-1-1');
    await queueLink.onclick();
    expect(opened).toBe(7);
    const title = card(7).querySelector('.task-graph-title');
    await title.onclick();
    expect(opened).toBe(7);
  } finally { restore(); }
});

/* ---------- 列表与筛选：显示 Wn，搜索能用编号命中，状态排序不变 ---------- */

test('worker list shows Wn, search matches the number, and state/order stay integer-keyed', () => {
  const task = { id: 5, parent_id: null, input_id: 5, task_kind: 'order', worker_number: 'W5', role: 'agent',
    status: 'running', integration: 'none', goal: '实现编号', updated_at: '2026-10-01T00:00:00Z' };
  const old = { id: 42, parent_id: null, input_id: 42, task_kind: 'order', worker_number: null, role: 'agent',
    status: 'running', integration: 'none', goal: '历史', updated_at: '2026-10-01T00:00:00Z' };
  renderTree({ tasks: [task, old], notices: [], status: { concurrency: 1 }, task_page: { total: 2, active: 2, shown: 2, historical: 0 } });
  const cards = [...dom.node('tasks').children];
  expect(deepText(cards[0])).toContain('W5');
  expect(cards[1].dataset.id).toBe(42);
  // Semantic reference token stays the integer identity, never a string number.
  expect(cards[0].dataset.ref).toContain('task-5');
  expect(cards[0].dataset.ref).not.toContain('W5');
  expect(matchTask(task, { text: 'w5' })).toBe(true);
  expect(matchTask(task, { text: '#5' })).toBe(true);
  expect(matchTask(task, { text: 'W5-1' })).toBe(false);
  expect(matchTask(old, { text: 'W5' })).toBe(false);
});
