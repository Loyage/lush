import { afterAll, beforeEach, expect, test } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
const dom = installDom();
const { ui } = await import('../../src/ui/web/assets/state.js');
const { renderTaskGraph } = await import('../../src/ui/web/assets/render-task-graph.js');
const { mergePhase, mergePriority } = await import('../../src/ui/web/assets/task-graph-merge.js');
const { taskForest } = await import('../../src/ui/web/assets/task-graph-layout.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const { captureGraph, restoreGraph, graphMotionRunning } = await import('../../src/ui/web/assets/task-graph-motion.js');
const { setPref } = await import('../../src/ui/web/assets/prefs.js');
const empty = () => ({ total: 0, counts: {}, items: [], truncated: false });
const node = (id, phase, parent_id = 1) => ({ id, parent_id, task_kind: id === 1 ? 'main' : 'child',
  status: 'waiting', title: `Task ${id}`, role: 'agent', target_branch: 'main', merge_queue: empty(),
  reservation: { version: 2, queue_protocol: 1, kind: 'merge', status: phase, parent_id } });
const card = id => dom.node('detail').querySelector(`[data-task-id="${id}"]`);
beforeEach(() => {
  ui.view = { id: 'task-graph' }; ui.taskGraphMinimal = false; ui.taskGraphShowArchived = false;
  dom.node('detail').replaceChildren(); dom.node('modal').replaceChildren(); dom.node('modal').hidden = true;
  document.activeElement = null; dom.setSelection('');
  for (const key of ['lush.taskGraph.collapsed', 'lush.taskGraph.hiddenStatuses', 'lush.reduceMotion']) localStorage.removeItem(key);
});
afterAll(() => dom.restore());

test('phase matrix only trusts matching current protocol; Agent status and Git divergence never promote requests', () => {
  const labels = { executing: '合并中', resolving: '分歧处理中', requested: '已请求等待合并', suspended: '交付挂起', blocked: '落地待核验' };
  for (const [phase, label] of Object.entries(labels)) {
    for (const minimal of [false, true]) {
      ui.taskGraphMinimal = minimal;
      const task = node(2, phase);
      task.status = 'paused';
      renderTaskGraph({ total: 1, nodes: [task] });
      expect(mergePhase(task)).toBe(phase);
      expect(deepText(card(2).querySelector('.task-graph-merge-relations'))).toContain(label);
      expect(card(2).querySelector('.task-graph-merge-dot') !== null).toBe(['executing', 'resolving'].includes(phase));
      expect(card(2).classList.contains('task-graph-running')).toBe(false);
      expect(deepText(card(2))).toContain('→');
    }
  }
  for (const patch of [{ status: 'pending' }, { status: 'integrated' }, { version: 1 }, { queue_protocol: null },
    { parent_id: 99 }, { kind: 'showcase' }, { status: 'unknown' }]) {
    const task = node(2, 'executing'); Object.assign(task.reservation, patch);
    Object.assign(task, { status: 'running', integration: 'pending', branch_info: { relation: { status: 'diverged' } } });
    expect(mergePhase(task)).toBeNull(); expect(mergePriority(task)).toBe(2);
    renderTaskGraph({ total: 1, nodes: [task] });
    expect(card(2).querySelector('.task-graph-merge-dot')).toBeNull();
  }
});

test('parent full summary survives filtering, collapsed children and missing IDs; links only navigate', async () => {
  const parent = node(1, null, null), child = node(2, 'requested');
  parent.merge_queue = { counts: { requested: 9, blocked: 1 }, total: 10, truncated: true,
    items: [{ id: 2, status: 'requested' }, { id: 900, status: 'requested' }, { id: 901, status: 'blocked' }] };
  child.status = 'completed';
  let opened;
  const restore = registerNavigation({ detail: id => { opened = id; } });
  try {
    for (const minimal of [false, true]) {
      ui.taskGraphMinimal = minimal;
      localStorage.setItem('lush.taskGraph.hiddenStatuses', '["completed"]');
      localStorage.setItem('lush.taskGraph.collapsed', '[1]');
      renderTaskGraph({ nodes: [parent, child], total: 999, truncated: true });
      expect(card(2)).toBeNull();
      const text = deepText(card(1));
      expect(text).toContain('9 条'); expect(text).toContain('另 7 条未列出');
      expect(text).toContain('落地待核验'); expect(text).toContain('#900');
      const link = card(1).querySelector('[data-graph-focus="merge-child-1-900"]');
      expect(link.classList.contains('agent-call')).toBe(false);
      await link.onclick(); expect(opened).toBe(900);
    }
  } finally { restore(); }
});

test('hidden intermediate preserves real target across refresh; roots and virtual siblings are not promoted', () => {
  const parent = node(1, null, null), hidden = { ...node(3, null), task_kind: 'analysis' };
  const child = node(4, 'executing', 3), sibling = node(2, 'requested');
  const graph = { nodes: [parent, hidden, child, sibling], total: 4 };
  renderTaskGraph(graph);
  expect(deepText(card(4).querySelector('.task-graph-merge-own'))).toContain('#3');
  expect(deepText(card(4).querySelector('.task-graph-merge-own'))).not.toContain('#1');
  renderTaskGraph(graph);
  expect(deepText(card(4).querySelector('.task-graph-merge-own'))).toContain('#3');
  const forest = taskForest({ nodes: [node(1, null, null), node(9, 'executing', 999), node(10, 'pending', null),
    node(2, 'executing'), node(3, 'requested'), node(4, 'resolving'), node(5, 'pending'), node(6, 'blocked'),
    { ...node(7, 'executing', 80), layout_parent_id: 1 }] });
  expect(forest.map(n => n.id)).toEqual([10, 9, 1]);
  expect(forest[2].children.map(n => n.id)).toEqual([7, 4, 2, 3, 6, 5]);
});

test('selection, editing and action layers defer refresh; focus survives normal refresh', () => {
  const graph = { nodes: [node(1, null, null), node(2, 'pending'), node(3, 'pending')], total: 3 };
  renderTaskGraph(graph);
  const original = card(2);
  graph.nodes[1].reservation.status = 'executing';
  dom.setSelection('reading'); renderTaskGraph(graph); expect(card(2)).toBe(original);
  dom.setSelection('');
  const input = document.createElement('textarea'); input.value = 'draft'; original.append(input);
  renderTaskGraph(graph); expect(card(2)).toBe(original); input.remove();
  dom.node('modal').hidden = false; dom.node('modal').append(document.createElement('section'));
  renderTaskGraph(graph); expect(card(2)).toBe(original);
  dom.node('modal').hidden = true;
  original.querySelector('.task-graph-title').focus();
  renderTaskGraph(graph); expect(card(2)).not.toBe(original);
  expect(document.activeElement.dataset.graphFocus).toBe('title-2');
});

test('FLIP only plays on reorders, keeps reading anchor, bounds duration and honors reduced motion', () => {
  const effects = [];
  const make = (id, top) => ({ dataset: { taskId: String(id) }, getBoundingClientRect: () => ({ top, bottom: top + 60, left: 0 }),
    animate: (frames, options) => { const effect = { frames, options, playState: 'running' }; effects.push(effect); return effect; } });
  let box = { dataset: { layoutKey: 'same' }, scrollLeft: 12, querySelectorAll: () => [make(1, 0), make(2, 60)] };
  const host = { scrollTop: 100, scrollHeight: 1000, clientHeight: 600, querySelector: () => box,
    getBoundingClientRect: () => ({ top: 0, bottom: 600 }) };
  const before = captureGraph(host);
  let next = { dataset: { layoutKey: 'same' }, querySelectorAll: () => [make(2, 0), make(1, 60)] };
  restoreGraph(host, next, before);
  expect(host.scrollTop).toBe(160); expect(next.scrollLeft).toBe(12);
  expect(effects).toHaveLength(2); expect(effects[0].options.duration).toBe(250);
  expect(graphMotionRunning(next)).toBe(true);
  effects.forEach(effect => effect.playState = 'finished'); expect(graphMotionRunning(next)).toBe(false);
  effects.length = 0;
  restoreGraph(host, box, before); expect(effects).toHaveLength(0); // content refresh
  next.dataset.layoutKey = 'filtered'; restoreGraph(host, next, before); expect(effects).toHaveLength(0);
  next.dataset.layoutKey = 'same';
  setPref('reduceMotion', true); restoreGraph(host, next, before); expect(effects).toHaveLength(0);
  setPref('reduceMotion', false);
  const media = globalThis.matchMedia;
  try { globalThis.matchMedia = () => ({ matches: true }); restoreGraph(host, next, before); expect(effects).toHaveLength(0); }
  finally { globalThis.matchMedia = media; }
  restoreGraph(host, next, { ...before, box: null }); expect(effects).toHaveLength(0); // first load
});
