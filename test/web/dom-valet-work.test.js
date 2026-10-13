import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';
import { until } from '../helpers.js';

const world = makeWorld(), requests = [], actions = [];
const json = value => ({ ok: true, json: async () => structuredClone(value) });
const valet = { id: 801, worker_number: 'V12', role: 'manager', task_kind: 'management', goal: '诊断 W20',
  status: 'waiting', calls: 0, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:01Z',
  result: '等待用户确认', management: { version: 1, revision: 'r1', origin: 'input', mode: 'once', enabled: true,
    state: 'waiting_actions', pending_signal: { due_at: '2026-10-01T00:00:00Z', actions: [{ action: 'start', target_id: 9, target_worker_number: 'W20', status: 'waiting' }],
      control_calls: [{ method: 'worker.cancel', status: 'pending_confirmation', notice_id: 82, notice_kind: 'questionnaire', params: { secret: 'PRIVATE_RECEIPT' } }] } },
  model_selection: { config_mode: 'lush', agent: 'pi', connection_id: 'source', model: 'openai/model', thinking: 'high', env: { secret: 'PRIVATE_MODEL' } },
  notices: [{ id: 82, kind: 'questionnaire', status: 'open', title: '确认取消', body: '确认精确请求', task_id: 801 }] };
let response = valet, intercept = null;
const dom = installDom({ fetch: (url, options = {}) => {
  const path = String(url); requests.push(path);
  if (options.body) actions.push(JSON.parse(options.body));
  const custom = intercept?.(path, options); if (custom) return custom;
  if (path.includes('/api/worker-lookup')) return json(response);
  if (path.endsWith('/api/worker/801')) return json(response);
  if (path.includes('/api/worker/801/history')) return json({ events: [], next_cursor: null, has_more: false });
  if (/\/api\/worker\/801\/transcript/.test(path)) return json({ steps: [], files: [], next: 0, has_more: false, has_older: false });
  if (path.endsWith('/api/hooks')) return json({ signals: { version: 1, revision: 'signals', items: [] }, management_workers: [valet] });
  return world.fetchImpl(url, options);
} });
const { ui, transcriptCache } = await import('../../src/ui/web/assets/state.js');
const { workerNumber } = await import('../../src/ui/web/assets/format.js');
const { workerLabel } = await import('../../src/ui/web/assets/worker-label.js');
const { linkWorkerNumbers, workerNumberTarget, resolveWorkerNumber } = await import('../../src/ui/web/assets/worker-links.js');
const { entityPreviewTarget, loadEntityPreview, previewPlaceholder } = await import('../../src/ui/web/assets/entity-preview.js');
const { filterTasks, parseFilters, describeFilters } = await import('../../src/ui/web/assets/sidebar.js');
const { renderTree } = await import('../../src/ui/web/assets/render-tree.js');
const { initSidebar } = await import('../../src/ui/web/assets/sidebar-init.js');
const { loadDetail } = await import('../../src/ui/web/assets/detail.js');
const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
const { renderTaskGraph } = await import('../../src/ui/web/assets/render-task-graph.js');
const { openManagement } = await import('../../src/ui/web/assets/render-management.js');
const { openTranscriptView, closeTranscriptView } = await import('../../src/ui/web/assets/transcript-view.js');
const { renderAgentSettings } = await import('../../src/ui/web/assets/settings-agent.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
beforeEach(() => {
  closeTranscriptView(); ui.disposeDetailRequests?.(); ui.workerNumbers = new Map(); ui.deletedWorkerIds = new Set();
  ui.filters = parseFilters(null); ui.lastSnapshot = { status: {}, tasks: [] }; ui.selected = null; ui.composerTask = null;
  ui.managementPage = null; ui.detailTask = null; response = structuredClone(valet); requests.length = 0; actions.length = 0; intercept = null;
  ui.taskHistory = []; ui.taskHistoryPage = null; ui.taskHistoryPending = null;
  dom.location.pathname = '/'; activateDetailView({ view: 'overview' }); dom.node('detail').replaceChildren();
});
afterAll(() => { closeTranscriptView(); ui.disposeDetailRequests?.(); dom.restore(); });

test('V numbers remain explicit flat safe identities; invalid V and W segments never become labels or links', async () => {
  for (const number of ['V1', 'V12', 'V9007199254740991', 'W1-2']) {
    expect(workerNumber({ id: 801, worker_number: number })).toBe(number);
    expect(workerNumberTarget(`#worker-number-${number}`)).toBe(number);
  }
  for (const number of ['V0', 'V01', 'V1-1', 'V1-01', 'V9007199254740992', 'W9007199254740992', 'W1-9007199254740992']) {
    expect(workerNumber({ id: 801, worker_number: number })).toBe('#801');
    expect(workerNumberTarget(`#worker-number-${number}`)).toBeNull();
  }
  expect(workerNumber({ id: 801, role: 'manager' })).toBe('#801');
  expect(workerLabel(valet)).toBe('V12'); expect(workerLabel(801)).toBe('V12');
  expect(workerLabel({ id: 801, worker_number: null, role: 'manager' })).toBe('#801');
  const node = document.createElement('p'); node.textContent = '（V12） V01 V1-1 V9007199254740992 /V12 V12.js `';
  linkWorkerNumbers(node); expect(node.querySelectorAll('a').map(link => link.textContent)).toEqual(['V12']);
  const link = node.querySelector('a'); expect(link.getAttribute('href')).toBe('#worker-number-V12');
  expect(link.getAttribute('aria-label')).toContain('Valet'); expect(requests).toHaveLength(0);
  expect(await resolveWorkerNumber('V12')).toBe(801);
  const target = entityPreviewTarget(link); expect(target.number).toBe('V12');
  expect(previewPlaceholder(target)).toContain('Valet V12');
  expect(await loadEntityPreview(target)).toContain('Valet V12');
  response = { ...valet, worker_number: 'V13' }; await expect(resolveWorkerNumber('V12')).rejects.toThrow('无法定位');
});

test('work type is distinct from historical role, filters are persisted and V search covers only loaded work', () => {
  const worker = { id: 1, role: 'research', task_kind: 'child', worker_number: 'W20', goal: '开发', status: 'waiting' };
  const old = { ...valet, id: 802, worker_number: null };
  const tasks = [worker, valet, old];
  expect(filterTasks(tasks, { type: 'worker' }).map(task => task.id)).toEqual([1]);
  expect(filterTasks(tasks, { type: 'valet' }).map(task => task.id)).toEqual([801, 802]);
  expect(filterTasks(tasks, { type: 'valet', role: 'research' })).toHaveLength(0);
  expect(filterTasks(tasks, { type: 'valet', text: 'V12' }).map(task => task.id)).toEqual([801]);
  expect(parseFilters(JSON.stringify({ tasks: { type: 'valet' } })).tasks.type).toBe('valet');
  expect(parseFilters(JSON.stringify({ tasks: { type: 'manager' } })).tasks.type).toBe('all');
  expect(describeFilters({ type: 'valet' })).toBe('类型：Valet');
  ui.filters.tasks.type = 'valet'; // Historical mixed-list preference cannot turn the development list into Valets.
  ui.filters.valets.text = 'V12';
  renderTree({ tasks, task_page: { total: 8, active: 3, historical: 5, shown: 0, has_more: true, cursor: 700, truncated: true } });
  expect(dom.node('tasks').querySelectorAll('.task').map(node => Number(node.dataset.id))).toEqual([1]);
  expect(dom.node('valets').querySelectorAll('.task').map(node => Number(node.dataset.id))).toEqual([801]);
  expect(deepText(dom.node('valets'))).toContain('Valet'); expect(deepText(dom.node('valets'))).not.toContain('待验收');
  expect(deepText(dom.node('valets'))).toContain('筛选仅覆盖已加载范围');
  ui.filters.valets.text = 'V99'; renderTree({ tasks, task_page: { has_more: true } });
  expect(deepText(dom.node('valets'))).toContain('更早记录尚未加载');
});

test('separate list controls preserve unsubmitted search drafts and actual Valet identity navigation', async () => {
  const snapshot = await (await world.fetchImpl('/api/snapshot')).json();
  snapshot.tasks = [{ id: 1, role: 'research', task_kind: 'child', worker_number: 'W20', goal: '开发', status: 'waiting' }, valet];
  ui.lastSnapshot = snapshot; initSidebar(); renderTree(snapshot);
  expect(dom.node('task-filters').querySelectorAll('.filter-select')).toHaveLength(1); // Integration only; no mixed type switch.
  const filters = dom.node('valet-filters'), keyword = filters.querySelector('.filter-input'); keyword.value = 'V99';
  await keyword.listeners.input[0]();
  const waiting = filters.querySelector('[data-value="waiting"]').querySelector('input'); waiting.checked = true; await waiting.listeners.change[0]();
  expect(dom.node('valets').querySelectorAll('.task').map(node => Number(node.dataset.id))).toEqual([801]);
  expect(keyword.value).toBe('V99'); expect(ui.filters.valets.text).toBe('');
  await keyword.listeners.keydown[0]({ key: 'Enter', preventDefault() {} });
  expect(dom.node('valets').querySelectorAll('.task')).toHaveLength(0);
  keyword.value = ''; await keyword.listeners.keydown[0]({ key: 'Enter', preventDefault() {} });
  expect(dom.node('tasks').querySelectorAll('.task').map(node => Number(node.dataset.id))).toEqual([1]);
  expect(dom.node('valets').querySelectorAll('.task').map(node => Number(node.dataset.id))).toEqual([801]);
  expect(deepText(dom.node('side-nav'))).toContain('工作列表'); expect(deepText(dom.node('side-nav'))).toContain('管家列表');
  const details = [], restore = (await import('../../src/ui/web/assets/navigate.js')).registerNavigation({ detail: id => details.push(id) });
  try { await dom.node('valets').querySelector('.task').onclick(); expect(details).toEqual([801]); } finally { restore(); }
  expect(actions).toHaveLength(0);
});

test('Valet list is not capped by the 100-binding snapshot and explicitly reads another bounded persistent history page', async () => {
  const records = Array.from({ length: 112 }, (_, index) => ({ ...valet, id: 1000 + index, worker_number: index ? `V${index}` : null, status: 'completed' }));
  const older = Array.from({ length: 50 }, (_, index) => ({ ...valet, id: 500 + index, worker_number: null, status: 'completed', goal: `更早管理 ${index}` }));
  const data = { tasks: records, notices: [], task_page: { total: 250, active: 0, historical: 250, shown: 112, cursor: 1000, has_more: true, truncated: true } };
  ui.lastSnapshot = data; renderTree(data);
  expect(dom.node('valets').querySelectorAll('.task')).toHaveLength(112); expect(dom.node('tasks').querySelectorAll('.task')).toHaveLength(0);
  expect(deepText(dom.node('valets'))).toContain('仍有更早分页未读取');
  expect(dom.node('valet-count').textContent).toContain('112 个已读取');
  intercept = path => path.includes('/api/workers?') ? json({ tasks: older, cursor: 500, has_more: true }) : null;
  await dom.node('valets').querySelectorAll('button').find(node => node.textContent === '加载更早 50 个').onclick();
  expect(requests).toEqual(['/api/workers?scope=all&before=1000&limit=50']);
  expect(dom.node('valets').querySelectorAll('.task')).toHaveLength(162); expect(ui.taskHistory).toHaveLength(50);
  expect(deepText(dom.node('valets'))).toContain('#500'); expect(deepText(dom.node('valets'))).not.toContain('V500');
  expect(dom.node('valet-count').textContent).toContain('162 个已读取'); expect(requests.some(path => path.includes('/api/hooks'))).toBe(false);
  expect(actions).toEqual([]);
});

test('Valet core detail reuses goal/result/Agent and record reader without Git or delegation reads', async () => {
  expect(await loadDetail(801)).toBe(true);
  await until(() => requests.some(path => path.includes('/history')));
  const panel = dom.node('detail'), text = deepText(panel);
  expect(dom.node('view-title').textContent).toBe('Valet V12'); expect(text).toContain('等待用户确认');
  expect(text).toContain('待用户确认（尚未执行）'); expect(text).toContain('已固定 Valet 配置');
  expect(text).not.toContain('PRIVATE_RECEIPT'); expect(text).not.toContain('PRIVATE_MODEL');
  expect(panel.querySelector('.agent-panel')).toBeTruthy(); expect(panel.querySelector('.management-state')).toBeTruthy();
  expect(panel.querySelector('.worker-relations')).toBeNull(); expect(panel.querySelector('.code-reader-open')).toBeNull();
  expect(panel.querySelector('a[href="#notices-82"]')).toBeTruthy();
  expect(requests.some(path => /\/diff|\/relations|\/code-|\/transcript/.test(path))).toBe(false);
  expect(actions).toHaveLength(0);
  const entry = panel.querySelectorAll('button').find(node => node.textContent === '打开执行详情'); await entry.onclick();
  expect(ui.transcriptView.panel.querySelectorAll('[role="tab"]').map(node => node.textContent)).toEqual(['执行记录']);
  expect(deepText(ui.transcriptView.panel)).toContain('Valet V12');
  expect(requests.some(path => path.includes('/transcript'))).toBe(true);
  closeTranscriptView(); transcriptCache.delete(801);
});

test('legacy unnumbered manager still has Valet reader with no code tab, and malformed development fields fail closed', async () => {
  const old = { ...valet, worker_number: null, branch: 'must-not-show', workspace: '/secret/worktree', children: [{ id: 9 }], calls: 0 };
  renderDetail(old, null, null, null);
  expect(deepText(dom.node('detail'))).not.toContain('must-not-show');
  expect(deepText(dom.node('detail'))).not.toContain('/secret/worktree');
  await openTranscriptView(801, undefined, { task: old, mode: 'code' });
  expect(ui.transcriptView.mode).toBe('transcript'); expect(deepText(ui.transcriptView.panel)).toContain('Valet #801');
  expect(ui.transcriptView.panel.querySelector('[id="execution-tab-code-801"]')).toBeNull();
  expect(requests.some(path => path.includes('/code-'))).toBe(false);
  closeTranscriptView(); transcriptCache.delete(801);
});

test('Valet settings compatibility redirects to read-only persistent list without reading binding snapshots', async () => {
  await openManagement({ subpage: 'history' });
  expect(dom.node('view-title').textContent).toBe('管家列表'); expect(dom.location.hash).toBe('#valets');
  expect(ui.indexOpen).toBe('valets'); expect(ui.managementPage).toBeNull();
  expect(dom.node('detail').querySelectorAll('.hook-manager')).toHaveLength(0);
  expect(dom.node('error').textContent).toContain('设置入口已移除');
  expect(requests).toHaveLength(0); expect(actions).toHaveLength(0);
});

test('development tree excludes management identity even with a malformed development task kind', () => {
  ui.taskGraphMinimal = true; activateDetailView({ view: 'task-graph' });
  renderTaskGraph({ nodes: [{ ...valet, task_kind: 'child', parent_id: 1 }, { id: 1, role: 'agent', task_kind: 'main', goal: 'main', status: 'waiting' }], edges: [{ from: 1, to: 801 }], total: 1 });
  expect(dom.node('detail').querySelector('[data-task-id="801"]')).toBeNull();
});

test('Agent settings shows Valet safely, not hidden manager or butler controls', async () => {
  const settings = structuredClone(world.state.agentConfig);
  settings.options.roles.push({ id: 'manager', label: '管理 Agent' });
  settings.roles.manager = { ...valet.model_selection, config_mode: 'pi', env: { private: 'HIDDEN_ENV' }, default_prompt: 'HIDDEN_PROMPT' };
  settings.resolved.manager = settings.roles.manager;
  const content = renderAgentSettings(settings, () => {}); dom.node('detail').append(content);
  const card = content.querySelector('[data-agent-target="manager"]');
  expect(card.querySelector('h3').textContent).toBe('Valet'); expect(card.querySelector('.management-profile-form')).toBeTruthy();
  expect(card.querySelector('textarea')).toBeNull(); expect(deepText(card)).not.toContain('HIDDEN_ENV'); expect(deepText(card)).not.toContain('HIDDEN_PROMPT');
  expect(card.querySelector('.agent-call')).toBeNull();
  await card.querySelectorAll('button').find(node => node.textContent === '保存配置').onclick();
  expect(actions.at(-1)).toMatchObject({ method: 'agent.configure', params: { config: { roles: { manager: { agent: 'pi', config_mode: 'pi' } } } } });
  expect(actions.at(-1).params.config.roles.manager).not.toHaveProperty('env');
});
