import { test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import { installDom, deepText } from '../dom-stub.js';
import { gate, until } from '../helpers.js';

const json = value => ({ ok: true, json: async () => structuredClone(value) });
const signal = { id: 'daily', name: '时间已到', enabled: true, schedule: { kind: 'daily', time: '00:05', timezone: 'UTC' }, next_run_at: '2030-01-01T00:05:00Z' };
const manager = { id: 900, name: '管理指令', role: 'manager', task_kind: 'management', status: 'waiting', goal: '重试 W10', calls: 1,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:01Z', result: '等待安全点',
  management: { version: 1, revision: 'binding-1', signal_id: signal.id, mode: 'persistent', enabled: false, can_enable: false,
    state: 'unknown', reason: '副作用未知，不自动重放', pending_signal: { id: 1, due_at: signal.next_run_at,
      actions: [{ action: 'retry', target_id: 10, target_worker_number: 'W10', status: 'waiting', reason: '等待分支安全点' }],
      control_calls: [{ method: 'worker.cancel', status: 'pending_confirmation', notice_id: 99, params: { secret: 'NEVER_SHOW' } }] } } };
const base = { version: 1, revision: 'templates-1', templates: [{ id: 'unrelated', name: '不应显示的 Hook 模板' }],
  signals: { version: 1, revision: 'signals-1', items: [signal] }, management_workers: [manager] };
let catalogue, reads, actions, intercept, details;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null;
  if (body) actions.push(body); else reads.push(path);
  const custom = intercept?.(path, body); if (custom) return custom;
  if (/\/api\/worker\/900\/transcript(?:-latest)?\?/.test(path)) return json({ steps: [], after: 0, before: 0, has_more: false });
  throw new Error(`unexpected ${path} ${body?.method}`);
} });
const { openManagement } = await import('../../src/ui/web/assets/render-management.js');
const { ui, transcriptCache } = await import('../../src/ui/web/assets/state.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
const { openTranscriptView, closeTranscriptView } = await import('../../src/ui/web/assets/transcript-view.js');
const { appendTranscriptSteps, paintTranscript } = await import('../../src/ui/web/assets/render-transcript.js');
const { setPref, writePref } = await import('../../src/ui/web/assets/prefs.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const restoreNavigation = registerNavigation({ refresh: async () => {}, detail: id => details.push(id) });
const root = () => dom.node('detail');
const btn = label => root().querySelectorAll('button').find(item => item.textContent === label);
const readerLink = () => root().querySelectorAll('a').find(item => item.textContent === '打开执行详情');
const render = row => { activateDetailView({ view: 'task', key: 'task-900' }); ui.selected = 900; renderDetail(row, null, null, null); };
beforeEach(() => {
  closeTranscriptView(); catalogue = structuredClone(base); reads = []; actions = []; details = []; intercept = null;
  dom.location.pathname = '/'; ui.managementPage = null; activateDetailView({ view: 'overview' }); root().replaceChildren(); transcriptCache.delete(900);
});
afterAll(() => { closeTranscriptView(); restoreNavigation(); dom.restore(); });

test('retired settings/history compatibility always opens persistent Valet list without configuration reads or writes', async () => {
  const original = structuredClone(catalogue);
  for (const options of [{ subpage: 'history', push: false }, { subpage: 'commands' }, {}]) {
    dom.location.hash = '#management-history'; await openManagement(options);
    expect(ui.view.id).toBe('valets'); expect(ui.indexOpen).toBe('valets'); expect(dom.location.hash).toBe('#valets');
    expect(dom.node('view-title').textContent).toBe('管家列表'); expect(dom.node('error').textContent).toContain('设置入口已移除');
    expect(root().querySelector('.management-page')).toBeNull(); expect(root().querySelector('form')).toBeNull();
    for (const label of ['新建时间信号', '新建管理指令', '保存时间信号', '启用管理绑定', '停用时间信号', '删除时间信号']) expect(btn(label)).toBeUndefined();
  }
  expect(catalogue).toEqual(original); expect(reads).toEqual([]); expect(actions).toEqual([]);
});

test('retired navigation is absent from published HTML; compatibility does not recreate editors in another project', async () => {
  const html = fs.readFileSync('src/ui/web/assets/index.html', 'utf8');
  expect(html).not.toContain('id="management-open"'); expect(html).toContain('id="side-valets"');
  for (const project of ['1111111111111111', '2222222222222222']) {
    dom.location.pathname = `/p/${project}/`; await openManagement(); expect(ui.view.id).toBe('valets');
    expect(root().querySelector('.signal-form')).toBeNull(); expect(root().querySelector('.management-form')).toBeNull();
  }
  expect(reads).toEqual([]); expect(actions).toEqual([]);
});

test('management detail retains safe receipts and real record reader, without binding mutations or replay', async () => {
  render(manager); const text = deepText(root());
  expect(text).toMatch(/重试\s+W10\s*：等待信号或安全点 · 等待分支安全点/);
  expect(text).toContain('待用户确认（尚未执行）'); expect(root().querySelector('a[href="#notices-99"]').textContent).toBe('N99');
  expect(text).not.toContain('NEVER_SHOW'); expect(text).toContain('副作用未知，不自动重放');
  await btn('刷新详情').onclick(); expect(details).toEqual([900]);
  expect(readerLink().target).toBe('_blank');
  await openTranscriptView(900, undefined, { task: manager }); expect(ui.transcriptView.taskId).toBe(900);
  expect(reads.some(path => path.includes('/api/worker/900/transcript'))).toBe(true);
  for (const label of ['启用管理绑定', '停用管理绑定', '合并', '验收', '归档', '重试']) expect(btn(label)).toBeUndefined();
  expect(actions).toEqual([]);
});

test('full Valet detail retains explicit V identity or legacy #id with one execution-only tab', async () => {
  for (const number of [null, 'V9']) {
    const task = { ...manager, worker_number: number }; render(task);
    await openTranscriptView(900, undefined, { task });
    expect(deepText(ui.transcriptView.panel)).toContain(`Valet ${number || '#900'}`);
    expect(ui.transcriptView.panel.querySelectorAll('[role="tab"]').map(node => node.textContent)).toEqual(['执行记录']);
    closeTranscriptView(); transcriptCache.delete(900);
  }
  expect(actions).toEqual([]); expect(reads.some(path => path.includes('/code-'))).toBe(false);
});

test('management execution reader renders timing, paging and sorting independently of Worker selection', async () => {
  const originalSelection = ui.selected; writePref('transcriptOrder', 'desc');
  const call = { seq: 3, file: 'manager', kind: 'tool', call_id: 'x', title: 'manager.query', body: '{"id":10}', at: '2026-01-01T00:00:00Z', model_duration_ms: 2500 };
  const output = { seq: 4, file: 'manager', kind: 'result', call_id: 'x', body: 'paused', at: '2026-01-01T00:00:01.250Z' };
  const older = { seq: 2, file: 'manager', kind: 'thinking', body: 'inspect first', model_duration_ms: 2500 }, all = [call];
  intercept = path => path.includes('/api/worker/900/transcript') ? json(path.includes('before=3')
    ? { steps: [older], oldest: 2, next: 2, has_older: false }
    : { steps: [...all], files: ['manager'], oldest: 3, next: all.at(-1).seq, has_older: true, has_more: false }) : null;
  try {
    render(manager); ui.selected = null;
    const trigger = readerLink(); trigger.focus();
    await openTranscriptView(900, undefined, { task: manager });
    const holder = ui.transcriptView.holder, item = holder.querySelector('.step');
    expect(ui.selected).toBeNull();
    expect(item.querySelector('.step-model-duration')).toBeNull();
    expect(item.querySelector('.step-duration').hidden).toBe(true);
    all.push(output); transcriptCache.get(900).steps.push(output); appendTranscriptSteps(900, [output]);
    expect(holder.querySelector('.step')).toBe(item);
    expect(item.querySelector('.step-duration').textContent).toBe('time≈1.3s');
    await holder.querySelector('[data-live="transcript-older"]').onclick();
    expect(deepText(holder)).toContain('inspect first');
    expect(holder.querySelector('[data-live="transcript-older"]').hidden).toBe(true);
    ui.selected = 901; transcriptCache.set(901, { steps: [{ seq: 1, kind: 'text', body: 'wrong Worker' }], files: [] });
    paintTranscript(901);
    expect(deepText(holder)).not.toContain('wrong Worker');
    setPref('transcriptOrder', 'asc');
    await until(() => transcriptCache.get(900)?.order === 'asc' && holder.querySelector('.step-duration')?.textContent === 'time≈1.3s');
    expect(reads.some(path => path.includes('/api/worker/900/transcript?after=0'))).toBe(true);
    expect(ui.selected).toBe(901);
    closeTranscriptView(); expect(dom.document.activeElement).toBe(trigger); expect(ui.view.id).toBe('task');
    expect(actions).toHaveLength(0);
  } finally { closeTranscriptView(); transcriptCache.delete(901); ui.selected = originalSelection; writePref('transcriptOrder', 'desc'); }
});

test('missing binding stays read-only and does not invent authorization', async () => {
  const row = { ...manager }; delete row.management; render(row);
  expect(deepText(root())).toContain('绑定状态暂不可用'); expect(btn('启用管理绑定')).toBeUndefined();
  await btn('刷新详情').onclick(); expect(details).toEqual([900]); expect(readerLink().target).toBe('_blank'); expect(actions).toEqual([]);
});

test('late Valet execution response cannot repaint a newer view or leave an active reader', async () => {
  const pending = gate(); intercept = path => path.includes('/api/worker/900/transcript') ? pending.promise : null;
  render(manager); const opening = openTranscriptView(900, undefined, { task: manager }); await until(() => reads.some(path => path.includes('/transcript')));
  closeTranscriptView(); activateDetailView({ view: 'overview' }); root().replaceChildren(document.createTextNode('新页面'));
  pending.resolve(json({ steps: [{ seq: 1, kind: 'text', body: 'OLD MANAGEMENT' }], files: [], next: 1, has_more: false })); await opening;
  expect(ui.transcriptView).toBeNull(); expect(deepText(root())).toBe('新页面'); expect(actions).toEqual([]);
});
