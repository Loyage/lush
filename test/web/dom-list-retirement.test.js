import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import { installDom, deepText, findByText } from './project-dom.js';
import { makeWorld } from './dom-world.js';
import { gate, until } from '../helpers.js';

const world = makeWorld(), reads = [], writes = [];
let intercept = null;
const dom = installDom({ fetch: (url, options = {}) => {
  reads.push(String(url)); if (options.body) writes.push(JSON.parse(options.body));
  return intercept?.(String(url), options) ?? world.fetchImpl(url, options);
} });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { renderTree } = await import('../../src/ui/web/assets/render-tree.js');
const { openResource, activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
await boot();
afterAll(() => dom.restore());
const valet = (id, number = null) => ({ id, worker_number: number, role: 'manager', task_kind: 'management', goal: `管理指令 ${id}`, status: 'completed', updated_at: '2026-10-01T00:00:00Z' });
const rows = id => dom.node(id).querySelectorAll('.task').map(node => Number(node.dataset.id));
const page = { total: 9, active: 1, historical: 8, shown: 3, cursor: 700, has_more: true, truncated: true };
function lists() {
  const data = { ...ui.lastSnapshot, tasks: [valet(801, 'V12'), valet(802), { id: 40, worker_number: 'W99', role: 'agent', task_kind: 'child', goal: '开发', status: 'running' },
    { id: 41, role: 'planner', task_kind: 'planner', layer: 'intent' }, { id: 42, role: 'agent', task_kind: 'merge' }], task_page: { ...page } };
  ui.lastSnapshot = data; ui.filters.tasks = {}; ui.filters.valets = {}; renderTree(data); return data;
}

test('two same-source lists separate persisted Valets from development/control records and keep literal identities', async () => {
  lists(); expect(rows('tasks')).toEqual([40]); expect(rows('valets').sort()).toEqual([801, 802]);
  expect(deepText(dom.node('valets'))).toContain('V12'); expect(deepText(dom.node('valets'))).toContain('#802');
  expect(deepText(dom.node('valets'))).not.toContain('V802'); expect(deepText(dom.node('valets'))).toContain('仍有更早分页未读取');
  expect(dom.node('view-title').textContent).not.toBe('Valet 设置');
  const input = dom.node('valet-filters').querySelector('.filter-input'); input.value = 'V99'; await input.listeners.input[0]();
  const running = dom.node('valet-filters').querySelector('[data-value="completed"]').querySelector('input'); running.checked = true; await running.listeners.change[0]();
  expect(rows('valets')).toHaveLength(2); // Non-text filters do not submit the draft.
  await input.listeners.keydown[0]({ key: 'Enter', preventDefault() {} }); expect(rows('valets')).toEqual([]);
  expect(deepText(dom.node('valets'))).toContain('更早记录尚未加载');
  input.value = 'V12'; await input.listeners.keydown[0]({ key: 'Enter', preventDefault() {} }); expect(rows('valets')).toEqual([801]);
  const opened = [], restore = registerNavigation({ detail: id => opened.push(id) });
  try { await dom.node('valets').querySelector('.task').onclick(); expect(opened).toEqual([801]); } finally { restore(); }
});

test('detail navigation from either loaded list highlights its matching resource even for an unnumbered Valet', () => {
  lists();
  for (const [id, expected] of [[801, 'valets'], [802, 'valets'], [40, 'tasks']]) {
    ui.selected = id; activateDetailView({ view: 'task', key: `task-${id}`, hash: `#worker-${id}` });
    expect(ui.navButtons.get(expected).getAttribute('aria-current')).toBe('page');
    expect(ui.navButtons.get(expected === 'valets' ? 'tasks' : 'valets').getAttribute('aria-current')).toBe('false');
  }
  openResource('valets');
});

test('Valet pagination is scope=all, merges shared history, shows failures/retry and ignores departed-page responses', async () => {
  lists(); openResource('valets'); reads.length = 0;
  intercept = url => url.startsWith('/api/workers?') ? Response.json({ tasks: [valet(600, 'V2')], cursor: 600, has_more: false }) : null;
  await findByText(dom.node('valets'), '加载更早 50 个').onclick();
  expect(reads).toEqual(['/api/workers?scope=all&before=700&limit=50']); expect(rows('valets')).toContain(600);
  expect(rows('tasks')).toEqual([40]); expect(reads.some(path => path.includes('/api/hooks'))).toBe(false);
  lists(); intercept = url => url.startsWith('/api/workers?') ? Response.json({ error: 'offline' }, { status: 503 }) : null;
  await findByText(dom.node('valets'), '加载更早 50 个').onclick(); expect(deepText(dom.node('valets'))).toContain('历史加载失败'); expect(rows('valets')).toHaveLength(2);
  const pending = gate(); intercept = url => url.startsWith('/api/workers?') ? pending.promise : null;
  const load = findByText(dom.node('valets'), '加载更早 50 个').onclick();
  openResource('tasks'); pending.resolve(Response.json({ tasks: [valet(599, 'V1')], cursor: 599, has_more: false })); await load;
  expect(rows('valets')).not.toContain(599); expect(ui.taskHistoryPending).toBeNull(); intercept = null;
});

test('retired hashes redirect with explicit removal notice; native sidebar and HTML expose no retired page', async () => {
  for (const hash of ['#management', '#management-history']) {
    dom.location.hash = hash; await dom.fire('hashchange'); expect(ui.indexOpen).toBe('valets'); expect(dom.location.hash).toBe('#valets');
    expect(dom.node('error').textContent).toContain('设置入口已移除');
  }
  for (const hash of ['#hook-tools', '#hooks-commands', '#hook-tools-history', '#hooks-commands-old', '#hooks-command-old', '#command-old']) {
    dom.location.hash = hash; await dom.fire('hashchange'); expect(ui.view.id).toBe('hooks'); expect(dom.location.hash).toBe('#hooks');
    expect(dom.node('error').textContent).toContain('入口已移除'); expect(dom.node('detail').querySelector('.shortcut-command-editor')).toBeNull();
  }
  const html = fs.readFileSync(new URL('../../src/ui/web/assets/index.html', import.meta.url), 'utf8');
  for (const id of ['versions-open', 'management-open', 'hook-tools-open']) expect(html).not.toContain(`id="${id}"`);
  expect(html).toContain('<strong>工作树</strong>'); expect(html).toContain('<h1>工作列表</h1>'); expect(html).toContain('<h1>管家列表</h1>');
  expect(writes).toHaveLength(0);
});

test('real hash routing keeps new pure settings and conditional input alongside retired tool redirects', async () => {
  const catalogue = { version: 1, automation_settings: { version: 1, revision: 'project-r',
    completion_defaults: { enabled: false, level: 'merge' }, acceptance_notice_defaults: { enabled: true },
    display_principles: { completion: 'all', push: 'all', convergence: 'all', acceptance_notice: 'all' } } };
  const beforeWrites = writes.length; reads.length = 0;
  intercept = url => url === '/api/hooks' ? Response.json(catalogue) : null;
  try {
    for (const feature of ['completion', 'push', 'acceptance_notice']) {
      dom.location.hash = `#hooks-${feature}-history`; await dom.fire('hashchange');
      expect(dom.location.hash).toBe(`#hooks-${feature}`); expect(ui.view.id).toBe('hooks');
      expect(dom.node('detail').querySelector(`[data-feature-settings="${feature}"]`)).toBeTruthy();
      expect(dom.node('detail').querySelector('.page-subnav')).toBeNull();
      expect(dom.node('detail').querySelector('.hook-execution')).toBeNull();
      expect(dom.node('detail').querySelector('a[href="#hook-tools"]')).toBeNull();
    }
    expect(reads.every(url => url === '/api/hooks')).toBe(true);
    for (const hash of ['#hooks-emission', '#hooks-emission-history']) {
      dom.location.hash = hash; await dom.fire('hashchange');
      expect(dom.location.hash).toBe('#drafts'); expect(ui.view.id).toBe('drafts'); expect(dom.node('detail').querySelector('.inputs-page').dataset.inputSection).toBe('drafts');
    }
    expect(writes).toHaveLength(beforeWrites);
  } finally { intercept = null; activateDetailView({ view: 'overview' }); }
});

test('legacy versions resolves persistent main identity, unavailable/error retry and late response cannot navigate another page', async () => {
  const opened = [], restore = registerNavigation({ detail: id => opened.push(id) });
  try {
    intercept = url => url === '/api/overview' ? Response.json({ tasks: [{ id: 77, task_kind: 'main', branch: 'main' }, { id: 1, task_kind: 'owner', branch: 'main' }] }) : null;
    dom.location.hash = '#versions'; await dom.fire('hashchange'); expect(opened).toEqual([77]); expect(dom.location.hash).toBe('#worker-77');
    intercept = url => url === '/api/overview' ? Response.json({ tasks: [] }) : null;
    dom.location.hash = '#versions'; await dom.fire('hashchange'); expect(deepText(dom.node('detail'))).toContain('没有可用的持久 main Worker');
    intercept = url => url === '/api/overview' ? Response.json({ error: 'failed' }, { status: 503 }) : null;
    dom.location.hash = '#versions'; await dom.fire('hashchange'); expect(deepText(dom.node('detail'))).toContain('main 身份读取失败'); expect(findByText(dom.node('detail'), '重新读取')).toBeTruthy();
    const pending = gate(); let started = false; intercept = url => url === '/api/overview' ? (started = true, pending.promise) : null;
    dom.location.hash = '#versions'; const load = dom.fire('hashchange'); await until(() => started);
    openResource('valets'); pending.resolve(Response.json({ tasks: [{ id: 88, task_kind: 'main', branch: 'main' }] })); await load;
    expect(opened).toEqual([77]); expect(ui.indexOpen).toBe('valets'); expect(dom.location.hash).toBe('#valets');
  } finally { restore(); intercept = null; activateDetailView({ view: 'overview' }); }
});
