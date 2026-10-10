import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from './project-dom.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { workerKind, workerKindLabel } = await import('../../src/ui/web/assets/worker-kind.js');
const { parentTasks, syncComposer } = await import('../../src/ui/web/assets/composer.js');
const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
const { renderOverview } = await import('../../src/ui/web/assets/render-overview.js');
const { renderTaskGraph } = await import('../../src/ui/web/assets/render-task-graph.js');
const { workerHooks } = await import('../../src/ui/web/assets/render-hooks.js');
const { iterationControls, isIterationTask } = await import('../../src/ui/web/assets/render-iteration.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { renderVersionCommit } = await import('../../src/ui/web/assets/render-versions.js');
await boot();
afterAll(() => dom.restore());

const record = task_kind => ({ id: 77, role: 'agent', task_kind, parent_id: 1, parent_task_kind: 'main',
  goal: '', title: '', status: 'waiting', branch: 'retained-say-branch', target_branch: 'main',
  workspace: '/tmp/retained-say-worktree', integration: 'pending', calls: 1,
  deps: [], dependents: [], children: [], messages: [], notices: [], reservation: null,
  auto_merge: { enabled: false, locked: false, editable: true, reason: null } });
const buttonOf = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);

test('order type read boundary normalizes historical say without rewriting records or unknown kinds', () => {
  const legacy = Object.freeze(record('say'));
  expect(workerKind(legacy)).toBe('order'); expect(workerKindLabel(legacy)).toBe('指令');
  expect(legacy.task_kind).toBe('say');
  expect(workerKindLabel(record('order'))).toBe('指令');
  expect(workerKind(record('future'))).toBe('future'); expect(workerKindLabel(record('child'))).toBe('child');
  expect(workerKind(null)).toBeUndefined();
});

for (const task_kind of ['order', 'say']) {
  test(`${task_kind} records retain composer, delivery, iteration and graph behavior with Chinese labels`, () => {
    const task = record(task_kind), before = JSON.stringify(task);
    expect(parentTasks([task]).map(row => row.id)).toEqual([77]);
    activateDetailView({ view: 'task', key: 'task-77' }); ui.selected = 77; ui.composerTask = task;
    syncComposer();
    expect(dom.node('input').disabled).toBe(false);
    expect(dom.node('input-form').dataset.mode).toBe('create');
    expect(dom.node('input-buffer').hidden).toBe(false);
    renderDetail(task, null, null, null);
    buttonOf(dom.node('detail'), '向该 Worker 追加输入').onclick();
    expect(dom.node('input').placeholder).toContain('追加给 Worker #77');
    expect(dom.node('input-buffer').hidden).toBe(true);
    expect(buttonOf(dom.node('detail'), '已解决')).toBeUndefined();
    // Missing answer and Git baseline must not be projected as a no-change acceptance candidate.
    expect(buttonOf(dom.node('detail'), '仅验收')).toBeUndefined();
    expect(workerHooks(task).querySelector('.auto-merge-toggle')).toBeTruthy();
    const accepted = { ...task, status: 'awaiting_acceptance', integration: 'merged' };
    expect(isIterationTask(accepted)).toBe(true);
    const controls = iterationControls(accepted, { refresh() {} });
    expect(buttonOf(controls, '验收')).toBeTruthy();
    expect(buttonOf(controls, '验收并归档')).toBeUndefined();
    activateDetailView({ view: 'task-graph' }); ui.taskGraphMinimal = false;
    renderTaskGraph({ nodes: [task], edges: [], total: 1 });
    const card = dom.node('detail').querySelector('[data-task-id="77"]');
    expect(card).toBeTruthy(); expect(deepText(card.querySelector('.task-graph-head'))).toContain('指令');
    expect(deepText(card.querySelector('.task-graph-head'))).not.toContain(task_kind);
    expect(JSON.stringify(task)).toBe(before);
  });
}

test('overview counts current and historical orders together without treating child confirmation as user acceptance', () => {
  ui.overviewKey = null;
  renderOverview({ revision: 'order-compat', status: { agents: [] }, notices: [], tasks: [
    { ...record('order'), status: 'awaiting_acceptance' },
    { ...record('say'), id: 78, status: 'awaiting_acceptance' },
    { ...record('child'), id: 79, status: 'awaiting_acceptance' },
  ] });
  const metrics = dom.node('detail').querySelectorAll('.metric');
  expect(deepText(metrics[0])).toContain('3'); expect(deepText(metrics[2])).toContain('2');
  expect(deepText(metrics[2])).toContain('1 个派生 Worker 待父确认');
  const titles = dom.node('detail').querySelectorAll('.branch-row').map(row => row.querySelector('button'));
  expect(titles.map(node => node.textContent)).toEqual(['child', '指令', '指令']);
  expect(deepText(dom.node('detail'))).toContain('retained-say-branch');
});

test('historical order content stays verbatim while version summary and CSS use the new name', () => {
  const input = { id: 9, content: 'say was the original request' };
  const card = renderVersionCommit({ commit: 'a'.repeat(40), short_commit: 'aaaaaaa', parents: [],
    subject: 'retained commit', author: { name: 'developer' }, committed_at: '2026-10-02T09:00:00Z',
    association: 'verified', tasks: [{ ...record('say'), input }] });
  expect(deepText(card)).toMatch(/原始指令\s+O9/);
  expect(card.querySelector('.record-link').getAttribute('href')).toBe('#input-input-9');
  expect(card.querySelector('.version-order').textContent).toBe(input.content);
});
