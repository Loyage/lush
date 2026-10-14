import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';
import { renderWorkerRelations } from '../../src/ui/web/assets/render-worker-relations.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';

const at = '2026-10-12T09:00:00Z';
const worker = (id, extra = {}) => ({ id, worker_number: `W232-${id}`, role: 'agent', task_kind: 'child',
  goal: `目标 ${id}`, status: 'running', calls: 0, created_at: at, updated_at: at,
  deps: [], dependents: [], children: [], ...extra });
const response = value => ({ ok: true, json: async () => value });
async function fixture(run) {
  const requests = [], dom = installDom({ fetch: url => { requests.push(String(url)); return response({ username: null }); } });
  resetUiState(); ui.view = { id: 'task', key: 'task-7' };
  try { await run(dom, requests); } finally { resetUiState(); dom.restore(); }
}
const moduleTitles = panel => panel.querySelectorAll('h2').map(node => node.textContent);

test('relations groups both dependency directions with real identity, code/control semantics, optional status and navigation', () => fixture(async dom => {
  const navigated = [], restore = registerNavigation({ detail: id => navigated.push(id) });
  try {
    const task = worker(7, { deps: [worker(20, { worker_number: 'W215-2', kind: 'code', integration: 'merged' }),
      worker(21, { worker_number: null, kind: 'control', status: undefined })],
      dependents: [worker(30, { worker_number: 'W232-3', kind: 'control', status: 'failed' })] });
    const section = renderWorkerRelations(task, { data: { parent: null, children: { items: [], total: 0, has_more: false } } });
    const groups = section.querySelectorAll('.worker-relation-dependencies');
    expect(groups).toHaveLength(2);
    expect(deepText(groups[0])).toContain('本 Worker 依赖'); expect(deepText(groups[0])).toContain('W215-2');
    expect(deepText(groups[0])).toContain('代码基线（code）'); expect(deepText(groups[0])).toContain('仅顺序（control）');
    expect(deepText(groups[0])).toContain('#21'); expect(deepText(groups[0])).toContain('状态不可用');
    expect(deepText(groups[1])).toContain('依赖本 Worker'); expect(deepText(groups[1])).toContain('W232-3');
    await groups[0].querySelector('button').onclick(); await groups[1].querySelector('button').onclick();
    expect(navigated).toEqual([20, 30]);
    section.bindRelations(worker(7, { deps: task.deps }), { current: () => true });
    expect(section.querySelectorAll('.worker-relation-dependencies')).toHaveLength(1);
    expect(deepText(section)).toContain('本 Worker 依赖'); expect(deepText(section)).not.toContain('依赖本 Worker');
    section.bindRelations(worker(7, { dependents: task.dependents }), { current: () => true });
    expect(section.querySelectorAll('.worker-relation-dependencies')).toHaveLength(1);
    expect(deepText(section)).not.toContain('本 Worker 依赖'); expect(deepText(section)).toContain('依赖本 Worker');
    section.bindRelations(worker(7), { current: () => true });
    expect(section.querySelectorAll('.worker-relation-dependencies')).toHaveLength(0);
    for (const text of ['本 Worker 依赖', '本 Worker 不依赖其他 Worker', '依赖本 Worker', '没有 Worker 在等它']) {
      expect(deepText(section)).not.toContain(text);
    }
  } finally { restore(); }
}));

test('detail has one code module and one conversation reader; history patches never create a second event module', () => fixture(async dom => {
  const panel = dom.node('detail'), task = worker(7, { branch: 'lush/task-7', target_branch: 'main', workspace: '/tmp/task-7' });
  const patches = renderDetail(task, { events: [], loading: true }, null, null, null, { current: () => true });
  try {
    const titles = moduleTitles(panel);
    expect(titles.filter(title => title === '代码与提交')).toHaveLength(1);
    for (const title of ['Worker 依赖', '工作区', '改动概览', '事件时间线']) expect(titles).not.toContain(title);
    const conversation = panel.querySelector('.conversation-panel');
    patches.update('history', { events: [{ id: 10, type: 'invocation.completed', created_at: at, data: { run_id: 5, result: '渐进结果' } }] }, true);
    expect(panel.querySelector('.conversation-panel')).toBe(conversation);
    expect(deepText(conversation)).toContain('渐进结果');
    expect(moduleTitles(panel)).not.toContain('事件时间线'); expect(panel.querySelectorAll('.conversation-panel')).toHaveLength(1);
    expect(panel.querySelector('.code-reader-open')).toBeTruthy();
  } finally { patches.dispose(); }
}));

test('progressive code patches preserve the explicit entry, diff reference and file expansion; repeated failures stay visible', () => fixture(async dom => {
  const task = worker(7), patches = renderDetail(task, { events: [] }, null, null, null,
    { current: () => true, requestDiff: () => Promise.resolve() });
  try {
    const section = dom.node('detail').querySelector('.detail-diff'), entry = section.querySelector('.code-reader-open');
    const diff = { committed: true, base_commit: 'aaaaaaa', head_commit: 'bbbbbbb', files_total: 1,
      files: [{ path: 'changed.js', added: 2, deleted: 1 }], pending: [], pending_total: 0, added: 2, deleted: 1 };
    patches.update('diff', diff, true);
    const files = section.querySelector('.diff-files'); files.open = true;
    const referenced = section.querySelector('.referenceable');
    expect(referenced.dataset.ref).toBe('diff-7');
    patches.update('diff', diff, true);
    expect(section.querySelector('.diff-files')).toBe(files); expect(files.open).toBe(true);
    patches.update('diff', { ...diff, added: 3 }, true);
    expect(section.querySelector('.diff-files').open).toBe(true);
    expect(section.querySelector('.code-reader-open')).toBe(entry); expect(section.querySelectorAll('h2')).toHaveLength(1);
    patches.update('diff', null, false); patches.update('diff', null, false);
    expect(deepText(section)).toContain('改动不可用；读取失败');
    expect(section.querySelector('.detail-diff-retry')).toBeTruthy();
    expect(section.querySelector('.code-reader-open')).toBe(entry);
  } finally { patches.dispose(); }
}));

test('history-only plan remains available inside one default-folded module and hides with progress disabled', () => fixture(async dom => {
  const task = worker(7, { progress_history: { items: [{ id: 42, archived_at: at, reason: 'replan',
    progress: { items: [{ key: 'old', label: '旧计划步骤', status: 'pending', work_ms: 1000, active_since: at }] } }], has_more: false, cursor: 42 } });
  renderDetail(task, null, null, null);
  const panel = dom.node('detail'), history = panel.querySelector('.progress-history-panel');
  expect(moduleTitles(panel).filter(title => title === '计划')).toHaveLength(1);
  expect(moduleTitles(panel)).not.toContain('当时计划'); expect(moduleTitles(panel)).not.toContain('过往计划');
  expect(history.tagName).toBe('DETAILS'); expect(Boolean(history.open)).toBe(false);
  expect(history.querySelectorAll('.detail-preview-body')).toHaveLength(0);
  expect(history.querySelectorAll('.is-running-duration')).toHaveLength(0);
  history.open = true; history.querySelector('.progress-history-version').open = true;
  renderDetail(task, null, null, null);
  expect(panel.querySelector('.progress-history-panel')).toBe(history); expect(history.open).toBe(true);
  ui.lastSnapshot = { status: { settings: { progress_reporting: { value: false } } } };
  renderDetail(task, null, null, null); expect(panel.querySelector('.progress-history-panel')).toBeNull();
  expect(moduleTitles(panel)).not.toContain('计划');
}));

test('Valet with no calls retains the shared record reader without development code or implicit file reads', () => fixture(async (dom, requests) => {
  renderDetail(worker(7, { role: 'manager', task_kind: 'management', workspace: '/tmp/management/7' }), null, null, null);
  const panel = dom.node('detail');
  expect(panel.querySelector('.management-readonly')).toBeTruthy();
  expect(panel.querySelector('.task-actions').querySelectorAll('button').map(node => node.textContent)).toEqual(['停止管家', '删除', '刷新详情']);
  expect(panel.querySelector('.code-reader-open')).toBeNull();
  expect(deepText(panel)).not.toContain('目录路径（管理工作目录）');
  expect(panel.querySelector('.agent-panel')).toBeTruthy();
  expect(panel.querySelector('.management-state')).toBeTruthy();
  expect(requests.some(url => /code-(?:state|tree|file)|transcript|action/.test(url))).toBe(false);
}));
