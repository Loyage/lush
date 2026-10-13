import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { until } from '../helpers.js';

const json = value => ({ ok: true, json: async () => structuredClone(value) });
const signal = { id: 'daily', name: '时间已到', enabled: true,
  schedule: { kind: 'daily', time: '00:05', timezone: 'UTC' }, next_run_at: '2030-01-01T00:05:00Z',
  last_execution: { status: 'skipped', due_at: '2026-01-01T00:05:00Z', reason: '停机错过，不补发' } };
const manager = { id: 900, name: '管理指令', role: 'manager', task_kind: 'management', status: 'waiting', goal: '重试 W10',
  management: { version: 1, revision: 'binding-1', signal_id: signal.id, mode: 'persistent', enabled: false,
    can_enable: false, state: 'unknown', reason: '副作用未知，不自动重放', pending_signal: { id: 1, due_at: signal.next_run_at,
      actions: [{ action: 'retry', target_id: 10, target_worker_number: 'W10', status: 'waiting', reason: '等待分支安全点' }],
      control_calls: [{ method: 'worker.cancel', status: 'pending_confirmation', notice_id: 99, params: { secret: 'NEVER_SHOW' } }] } } };
const base = { version: 1, revision: 'templates-1', templates: [{ id: 'unrelated', name: '不应显示的 Hook 模板' }],
  signals: { version: 1, revision: 'signals-1', items: [signal] }, management_workers: [manager] };
let catalogue, reads, actions, intercept, details;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null;
  if (body) actions.push(body); else reads.push(path);
  const custom = intercept?.(path, body); if (custom) return custom;
  if (path.endsWith('/api/hooks')) return json(catalogue);
  if (path.endsWith('/api/agent/connections')) return json({ version: 1, connections: [] });
  if (/\/api\/worker\/900\/transcript(?:-latest)?\?/.test(path)) return json({ steps: [], after: 0, before: 0, has_more: false });
  if (body?.method === 'hooks.signal_save') return json({ ...catalogue,
    signals: { ...catalogue.signals, revision: 'signals-2', items: [{ ...signal, enabled: body.params.signal.enabled }] } });
  throw new Error(`unexpected ${path} ${body?.method}`);
} });
const { openManagement } = await import('../../src/ui/web/assets/render-management.js');
const { ui, transcriptCache } = await import('../../src/ui/web/assets/state.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const { closeTranscriptView } = await import('../../src/ui/web/assets/transcript-view.js');
const { appendTranscriptSteps, paintTranscript } = await import('../../src/ui/web/assets/render-transcript.js');
const { setPref, writePref } = await import('../../src/ui/web/assets/prefs.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const restoreNavigation = registerNavigation({ refresh: async () => {}, detail: id => { details.push(id); } });
const root = () => dom.node('detail');
const btn = (label, node = root()) => node.querySelectorAll('button').find(item => item.textContent === label);
const input = label => root().querySelector(`[aria-label="${label}"]`);
const tab = id => root().querySelector(`[data-subpage="${id}"]`);
beforeEach(() => {
  closeDialog(); closeTranscriptView(); catalogue = structuredClone(base); reads = []; actions = []; details = []; intercept = null;
  dom.location.pathname = '/'; ui.managementPage = null; activateDetailView({ view: 'overview' }); transcriptCache.delete(900);
});
afterAll(() => { closeDialog(); closeTranscriptView(); restoreNavigation(); dom.restore(); });

test('management navigation honors push=false and invalid subpages fail back to settings', async () => {
  const pushes = dom.pushed(); dom.location.hash = '#management-history';
  await openManagement({ subpage: 'history', push: false });
  expect(ui.view.id).toBe('management'); expect(dom.pushed()).toBe(pushes);
  expect(dom.node('view-title').textContent).toBe('Valet 设置');
  expect(ui.managementPage.historyNode.hidden).toBe(false); expect(ui.managementPage.settingsNode.hidden).toBe(true);
  expect(tab('history').getAttribute('aria-current')).toBe('page');
  await openManagement({ subpage: 'commands' });
  expect(dom.location.hash).toBe('#management'); expect(tab('settings').getAttribute('aria-current')).toBe('page');
  expect(reads).toEqual(['/api/hooks']); expect(actions).toHaveLength(0);
  expect(deepText(root())).not.toContain('不应显示的 Hook 模板');
});

test('settings/history tabs preserve independent drafts, focus, folds and revision-pinned edits without another read', async () => {
  await openManagement(); await btn('新建管理指令').onclick(); input('管理指令名称').value = '保留管理草稿';
  await btn('新建时间信号').onclick(); input('信号名称').value = '保留信号草稿';
  input('信号周期').value = 'daily'; input('信号周期').onchange();
  const form = root().querySelector('.signal-form'), management = root().querySelector('.management-form');
  const name = input('信号名称'); name.focus(); name.selectionStart = 2; name.selectionEnd = 3;
  await btn('停用时间信号').onclick();
  expect(root().querySelector('.signal-form')).toBe(form); expect(dom.document.activeElement).toBe(name);
  const settings = ui.managementPage.settingsNode;
  await settings.querySelector('[data-module="signals"]').querySelector('.automation-module-toggle').onclick();
  await tab('history').onclick();
  expect(dom.location.hash).toBe('#management-history'); expect(ui.managementPage.settingsNode.hidden).toBe(true);
  await tab('settings').onclick();
  expect(root().querySelector('.signal-form')).toBe(form); expect(root().querySelector('.management-form')).toBe(management);
  expect(input('管理指令名称').value).toBe('保留管理草稿'); expect(name.value).toBe('保留信号草稿');
  expect(settings.querySelector('[data-module="signals"]').moduleOpen).toBe(false);
  await btn('保存时间信号', settings).onclick();
  expect(actions.at(-1).params.expected_revision).toBe('signals-1');
  expect(reads).toEqual(['/api/hooks', '/api/agent/connections']);
});

test('history shows safe receipts, exposes real detail and execution readers, and never offers mutation or replay', async () => {
  await openManagement({ subpage: 'history' }); const history = ui.managementPage.historyNode;
  expect(deepText(history)).toContain('不是完整调用历史'); expect(deepText(history)).toContain('停机错过，不补发');
  expect(deepText(history)).toContain('重试 W10：等待信号或安全点 · 等待分支安全点');
  expect(deepText(history)).toContain('待用户确认（尚未执行）'); expect(deepText(history)).toContain('确认提醒 N99');
  expect(deepText(history)).not.toContain('NEVER_SHOW');
  for (const label of ['新建时间信号', '新建管理指令', '保存时间信号', '启用管理绑定', '停用时间信号', '删除时间信号']) expect(btn(label, history)).toBeUndefined();
  await btn('查看指令、结果与调用历史', history).onclick(); expect(details).toEqual([900]);
  await btn('打开执行详情', history).onclick();
  expect(ui.transcriptView.taskId).toBe(900); expect(reads.some(path => path.includes('/api/worker/900/transcript'))).toBe(true);
  expect(actions).toHaveLength(0);
});

test('compact hooks summaries preserve Valet identity without inventing V numbers for legacy rows', async () => {
  for (const number of [null, 'V9']) {
    const compact = { ...manager, worker_number: number }; delete compact.role; delete compact.task_kind;
    catalogue.management_workers = [compact]; ui.managementPage = null; transcriptCache.delete(900);
    activateDetailView({ view: 'overview' }); await openManagement();
    const entry = btn('打开执行详情');
    expect(entry.getAttribute('data-preview-text')).toContain(`Valet ${number || '#900'}`);
    await entry.onclick();
    expect(deepText(ui.transcriptView.panel)).toContain(`Valet ${number || '#900'}`);
    expect(ui.transcriptView.panel.querySelectorAll('[role="tab"]').map(node => node.textContent)).toEqual(['执行记录']);
    closeTranscriptView();
  }
  expect(actions).toHaveLength(0); expect(reads.some(path => path.includes('/code-'))).toBe(false);
});

test('management execution entry renders timing, pagination and sorting independently of Worker selection', async () => {
  const originalSelection = ui.selected;
  writePref('transcriptOrder', 'desc');
  const call = { seq: 3, file: 'manager', kind: 'tool', call_id: 'x', title: 'manager.query', body: '{"id":10}',
    at: '2026-01-01T00:00:00Z', model_duration_ms: 2500 };
  const output = { seq: 4, file: 'manager', kind: 'result', call_id: 'x', body: 'paused',
    at: '2026-01-01T00:00:01.250Z' };
  const older = { seq: 2, file: 'manager', kind: 'thinking', body: 'inspect first', model_duration_ms: 2500 };
  const all = [call];
  intercept = path => path.includes('/api/worker/900/transcript') ? json(path.includes('before=3')
    ? { steps: [older], oldest: 2, next: 2, has_older: false }
    : { steps: [...all], files: ['manager'], oldest: 3, next: all.at(-1).seq, has_older: true, has_more: false }) : null;
  try {
    ui.selected = null;
    await openManagement({ subpage: 'history' });
    const trigger = btn('打开执行详情'); trigger.focus();
    await trigger.onclick();
    const holder = ui.transcriptView.holder, item = holder.querySelector('.step');
    expect(ui.selected).toBeNull();
    expect(item.querySelector('.step-model-duration').textContent).toBe('模型回复用时 ≈ 2.5 秒（估算）');
    expect(item.querySelector('.step-duration').textContent).toBe('工具用时未知');
    all.push(output); transcriptCache.get(900).steps.push(output); appendTranscriptSteps(900, [output]);
    expect(holder.querySelector('.step')).toBe(item);
    expect(item.querySelector('.step-duration').textContent).toBe('工具用时 ≈ 1.3 秒（估算）');
    await holder.querySelector('[data-live="transcript-older"]').onclick();
    expect(deepText(holder)).toContain('inspect first');
    expect(holder.querySelector('[data-live="transcript-older"]').hidden).toBe(true);
    ui.selected = 901; transcriptCache.set(901, { steps: [{ seq: 1, kind: 'text', body: 'wrong Worker' }], files: [] });
    paintTranscript(901);
    expect(deepText(holder)).not.toContain('wrong Worker');
    setPref('transcriptOrder', 'asc');
    await until(() => transcriptCache.get(900)?.order === 'asc' && holder.querySelector('.step-duration')?.textContent.includes('1.3 秒'));
    expect(reads.some(path => path.includes('/api/worker/900/transcript?after=0'))).toBe(true);
    expect(ui.selected).toBe(901);
    closeTranscriptView(); expect(dom.document.activeElement).toBe(trigger); expect(ui.view.id).toBe('management');
    expect(actions).toHaveLength(0);
  } finally { closeTranscriptView(); transcriptCache.delete(901); ui.selected = originalSelection; writePref('transcriptOrder', 'desc'); }
});

test('missing binding projection still provides read-only detail/execution without inventing authorization', async () => {
  delete catalogue.management_workers[0].management;
  await openManagement();
  expect(deepText(root())).toContain('绑定状态暂不可用'); expect(btn('启用管理绑定')).toBeUndefined();
  await btn('查看指令、结果与调用历史').onclick(); expect(details).toEqual([900]); expect(btn('打开执行详情')).toBeTruthy();
  expect(actions).toHaveLength(0);
});

test('explicit refresh cancellation preserves drafts; confirmed read failure does not discard loaded records', async () => {
  await openManagement(); await btn('新建时间信号').onclick(); input('信号名称').value = '仍然保留';
  const form = root().querySelector('.signal-form');
  const cancelled = btn('刷新目录').onclick(); await dialogButton(dom, '取消').onclick(); await cancelled;
  expect(root().querySelector('.signal-form')).toBe(form); expect(input('信号名称').value).toBe('仍然保留');
  intercept = path => path.endsWith('/api/hooks') ? { ok: false, json: async () => ({ error: '目录暂不可用' }) } : null;
  const refreshed = btn('刷新目录').onclick(); await dialogButton(dom, '放弃并刷新').onclick(); await refreshed;
  expect(root().querySelector('.signal-form')).toBeNull(); expect(deepText(root())).toContain('管理指令');
  expect(dom.node('error').textContent).toContain('已加载记录'); expect(actions).toHaveLength(0);
});

test('late initial catalogue cannot overwrite a later project or document with the same management route', async () => {
  let resolve;
  intercept = path => path.endsWith('/api/hooks') ? new Promise(done => { resolve = done; }) : null;
  const loading = openManagement(); await until(() => resolve);
  const oldView = ui.view;
  intercept = null; dom.location.pathname = '/p/2222222222222222/'; await openManagement();
  expect(ui.view).toBe(oldView); const next = root().querySelector('.management-page');
  resolve(json({ ...base, management_workers: [{ ...manager, name: 'OLD PROJECT' }] })); await loading;
  expect(root().querySelector('.management-page')).toBe(next); expect(deepText(root())).not.toContain('OLD PROJECT');
  // Document identity independently invalidates a pending response even if view/project are unchanged.
  intercept = path => path.endsWith('/api/hooks') ? new Promise(done => { resolve = done; }) : null;
  const refreshing = btn('刷新目录').onclick(); await until(() => resolve);
  const original = globalThis.document, replacement = { ...original };
  try {
    globalThis.document = replacement; intercept = null; await openManagement(); const newer = root().querySelector('.management-page');
    resolve(json({ ...base, management_workers: [{ ...manager, name: 'OLD DOCUMENT' }] })); await refreshing;
    expect(root().querySelector('.management-page')).toBe(newer); expect(deepText(root())).not.toContain('OLD DOCUMENT');
  } finally { globalThis.document = original; }
  expect(actions).toHaveLength(0);
});

test('parent feature directory remains separate and late management mutations cannot repaint a reentered page', async () => {
  const { openHooks } = await import('../../src/ui/web/assets/render-hooks.js');
  await openManagement();
  const staleDetail = btn('查看指令、结果与调用历史');
  await btn('新建时间信号').onclick(); input('信号名称').value = '旧页信号';
  input('信号周期').value = 'daily'; input('信号周期').onchange();
  let resolve;
  intercept = (_path, body) => body?.method === 'hooks.signal_save' ? new Promise(done => { resolve = done; }) : null;
  const saving = btn('保存时间信号').onclick(); await until(() => resolve);
  const readCount = reads.length;
  await openHooks();
  expect(ui.view.id).toBe('hooks'); expect(dom.location.hash).toBe('#hooks');
  expect(reads).toHaveLength(readCount); expect(root().querySelectorAll('.automation-feature')).toHaveLength(4);
  expect(root().querySelector('.hook-managers')).toBeNull(); expect(btn('新建时间信号')).toBeUndefined();
  await staleDetail.onclick(); expect(details).toHaveLength(0);
  await openManagement(); const replacement = root().querySelector('.management-page');
  resolve(json({ ...base, signals: { ...base.signals, revision: 'OLD PAGE' } })); await saving;
  expect(root().querySelector('.management-page')).toBe(replacement);
  expect(ui.managementPage.catalogue.signals.revision).toBe('signals-1'); expect(dom.location.hash).toBe('#management');
  expect(actions).toHaveLength(1);
});
