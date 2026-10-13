import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { until } from '../helpers.js';
const json = value => ({ ok: true, json: async () => structuredClone(value) });
const defaults = { completion_defaults: { enabled: false, level: 'accept' } };
const completion = level => ({ level, min_level: 'off', editable: true, locked: false, state: 'idle', phase: null });
function worker(id, extra = {}) {
  return { id, worker_number: `W${900 + id}`, task_kind: 'order', status: 'waiting', goal: '开发', ...extra,
    hooks: { worker_id: id, revision: `revision-${id}`, completion: completion('off'), mounts: [], ...extra.hooks } };
}
const page = (workers, more = false) => ({ version: 1, workers, cursor: workers.at(-1)?.id ?? null, has_more: more, limit: 25 });
function mount(id, tool, status = 'succeeded', extra = {}) {
  return { id: tool === 'request_merge' ? 'auto-merge' : 'auto-accept', actions: [{ type: tool }],
    operation: { version: 1, id: `operation-${id}-${tool}`, worker_id: id, tool, status, ...extra } };
}
let reads, actions, intercept, owned, currentPage, nodes;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null;
  if (body) actions.push(body); else reads.push({ path, signal: options.signal });
  const result = intercept?.(path, body); if (result) return result;
  if (path.endsWith('/api/hooks')) return json(defaults);
  if (path.includes('/api/automation/completion/workers')) return json(currentPage);
  if (body?.method === 'worker.completion') return json({ worker_id: body.params.id, revision: 'saved-revision', completion: completion(body.params.level), mounts: [] });
  throw new Error(`unexpected ${path}`);
} });
const { renderCompletionAutomation } = await import('../../src/ui/web/assets/automation-completion.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const { openProjectAutomation } = await import('../../src/ui/web/assets/render-project-automation.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const button = (root, text) => root.querySelectorAll('button').find(node => node.textContent === text);
const choice = (root, id, level) => root.querySelector(`[data-worker-id="${id}"]`).querySelector(`[data-level="${level}"]`);
async function render(catalogue = defaults) {
  const node = renderCompletionAutomation({ catalogue, ownsPage: () => owned }); nodes.push(node);
  dom.node('detail').replaceChildren(node); await node.ready; return node;
}
beforeEach(() => {
  closeDialog(); ui.disposeProjectAutomation?.(); for (const node of nodes || []) node.dispose();
  activateDetailView({ view: 'overview' }); ui.automationPage = null;
  reads = []; actions = []; intercept = null; nodes = []; owned = true; currentPage = page([worker(7)]); dom.location.pathname = '/p/1111111111111111/';
});
afterAll(() => { closeDialog(); ui.disposeProjectAutomation?.(); for (const node of nodes) node.dispose(); dom.restore(); });

test('local component preserves parent view and detail, device scope and cached tabs without extra reads', async () => {
  const view = ui.view;
  const node = await render();
  expect(ui.view).toBe(view); expect(dom.node('detail').children).toEqual([node]);
  expect(deepText(node)).toContain('项目没有覆盖'); expect(node.querySelector('a').href).toBe('/#automation');
  expect(reads.map(row => row.path)).toEqual(['/p/1111111111111111/api/automation/completion/workers?limit=25']);
  const row = node.querySelector('.completion-worker');
  node.setSubpage('history'); expect(node.querySelector('.automation-completion-settings').hidden).toBe(true);
  node.setSubpage('settings'); expect(node.querySelector('.completion-worker')).toBe(row);
  expect(reads).toHaveLength(1); node.updateCatalogue({ completion_defaults: { enabled: true, level: 'merge' } });
  expect(deepText(node.querySelector('.completion-defaults'))).toContain('自动到合并'); expect(actions).toHaveLength(0);
  node.dispose();
});

test('actual Worker controls share revisions, child locks, freezing, Agent cost and acceptance confirmation', async () => {
  currentPage = page([worker(9, { task_kind: 'child' }), worker(8, { reservation: { status: 'requested' } }), worker(7)]);
  const node = await render();
  expect(choice(node, 9, 'merge').disabled).toBe(true); expect(choice(node, 9, 'merge').parentNode.getAttribute('data-help')).toContain('用户不能修改');
  expect(choice(node, 8, 'merge').disabled).toBe(true);
  expect(choice(node, 7, 'accept').classList.contains('agent-call')).toBe(true);
  expect(choice(node, 7, 'accept').getAttribute('data-help')).toContain('token');
  const pending = choice(node, 7, 'accept').onclick();
  expect(button(node, '刷新当前页').disabled).toBe(true); node.setSubpage('history'); node.setSubpage('settings');
  expect(deepText(dom.node('modal'))).toContain('worktree/ref');
  await dialogButton(dom, '授权自动验收').onclick(); await pending;
  expect(actions).toEqual([{ method: 'worker.completion', params: { id: 7, level: 'accept', expected_revision: 'revision-7' } }]);
  expect(reads).toHaveLength(2); node.dispose();
});

test('history only uses matching real operation evidence, never setting or Agent-return receipts', async () => {
  currentPage = page([worker(7, { hooks: { completion: { ...completion('accept'), state: 'succeeded', last_execution: { status: 'succeeded' } },
    mounts: [mount(7, 'request_merge', 'submitted'), mount(7, 'accept_worker', 'failed', { error: '<script>真实安全诊断</script>' })] } }),
    worker(6, { hooks: { mounts: [mount(100, 'request_merge')] } })]);
  const node = await render(); node.setSubpage('history');
  const history = node.querySelector('.completion-history-rows');
  expect(history.querySelectorAll('.completion-record')).toHaveLength(2);
  expect(deepText(history)).toContain('请求已提交'); expect(deepText(history)).toContain('操作失败');
  expect(deepText(history)).not.toContain('安全验收及资源回收完成');
  expect(deepText(history)).toContain('身份不符'); expect(history.querySelector('script')).toBeNull(); node.dispose();
});

test('true cursor pagination includes pages with no records and cached previous page, with explicit unseen range', async () => {
  currentPage = page([worker(7)], true); const node = await render();
  expect(deepText(node)).toContain('还有未读取的 Worker'); expect(deepText(node)).toContain('不代表其他页');
  currentPage = page([worker(4, { hooks: { mounts: [mount(4, 'request_merge')] } })]);
  await button(node, '下一页').onclick();
  expect(reads.at(-1).path).toBe('/p/1111111111111111/api/automation/completion/workers?limit=25&before=7');
  expect(deepText(node)).toContain('第 2 页'); expect(deepText(node)).toContain('已到 Worker 分页末尾');
  expect(button(node, '下一页').disabled).toBe(true);
  await button(node, '上一页').onclick(); expect(reads).toHaveLength(2); expect(deepText(node)).toContain('第 1 页'); node.dispose();
});

test('failure and incompatible pagination keep confirmed rows rather than claiming no records', async () => {
  const node = await render(); const row = node.querySelector('.completion-worker');
  intercept = () => Promise.reject(new Error('offline'));
  await button(node, '刷新当前页').onclick(); expect(deepText(node)).toContain('读取失败'); expect(node.querySelector('.completion-worker')).toBe(row);
  intercept = null; currentPage = { ...page([worker(7)]), has_more: true, cursor: 8 };
  await button(node, '刷新当前页').onclick(); expect(deepText(node)).toContain('版本不兼容'); expect(node.querySelector('.completion-worker')).toBe(row); node.dispose();
});

test('late reads, invalid routes and disposal cannot paint a departed feature or project; requests abort', async () => {
  for (const mode of ['dispose','project','invalid','owner']) {
    dom.location.pathname = '/p/1111111111111111/'; owned = true;
    let release; intercept = () => new Promise(resolve => { release = resolve; });
    const node = renderCompletionAutomation({ ownsPage: () => owned, catalogue: defaults }); nodes.push(node);
    await until(() => release); const before = deepText(node);
    if (mode === 'dispose') { node.dispose(); expect(reads.at(-1).signal.aborted).toBe(true); }
    else if (mode === 'owner') owned = false;
    else dom.location.pathname = mode === 'project' ? '/p/2222222222222222/' : '/p/bad/';
    release(json(currentPage)); await node.ready;
    expect(deepText(node)).toBe(before); expect(node.querySelector('.completion-worker')).toBeNull(); node.dispose();
  }
});

test('parent history deep link, tabs and directory return reuse the feature without extra reads or global ownership changes', async () => {
  await openProjectAutomation({ feature: 'completion', subpage: 'history' });
  const node = dom.node('detail').querySelector('.automation-completion');
  const view = ui.view;
  expect(dom.location.hash).toBe('#hooks-completion-history');
  expect(node.querySelector('.automation-completion-history').hidden).toBe(false);
  await openProjectAutomation({ feature: 'completion' });
  expect(ui.view).toBe(view); expect(dom.location.hash).toBe('#hooks-completion');
  expect(node.querySelector('.automation-completion-settings').hidden).toBe(false);
  await openProjectAutomation(); expect(dom.node('detail').querySelector('.automation-completion')).toBeNull();
  await openProjectAutomation({ feature: 'completion' });
  expect(dom.node('detail').querySelector('.automation-completion')).toBe(node);
  expect(reads).toHaveLength(2); expect(actions).toHaveLength(0);
});

test('retained feature releases inactive initial read and re-reads on return without painting the directory', async () => {
  let release;
  intercept = path => path.includes('/api/automation/completion/workers') ? new Promise(resolve => { release = resolve; }) : null;
  const opening = openProjectAutomation({ feature: 'completion' });
  await until(() => release && ui.automationPage?.nodes.has('completion'));
  const node = ui.automationPage.nodes.get('completion');
  await openProjectAutomation(); const directory = dom.node('detail').querySelector('.automation-browse');
  release(json(currentPage)); await opening;
  expect(node.querySelector('.completion-worker')).toBeNull(); expect(directory.hidden).toBe(false);
  intercept = null; await openProjectAutomation({ feature: 'completion' });
  expect(dom.node('detail').querySelector('.automation-completion')).toBe(node);
  expect(node.querySelector('.completion-worker')).toBeTruthy();
  expect(node.getAttribute('aria-busy')).toBe('false'); expect(button(node, '刷新当前页').disabled).toBe(false);
  expect(reads.filter(row => row.path.includes('/api/automation/completion/workers'))).toHaveLength(2);
});

test('retained feature re-reads discarded device defaults on return without replacing its confirmed Worker page', async () => {
  let release;
  intercept = path => path.endsWith('/api/hooks') ? new Promise(resolve => { release = resolve; }) : null;
  const opening = openProjectAutomation({ feature: 'completion' });
  await until(() => release && ui.automationPage?.nodes.get('completion')?.querySelector('.completion-worker'));
  const node = ui.automationPage.nodes.get('completion'), row = node.querySelector('.completion-worker');
  await openProjectAutomation(); release(json(defaults)); await opening;
  expect(deepText(node.querySelector('.completion-defaults'))).not.toContain('读取时设备默认');
  intercept = null; await openProjectAutomation({ feature: 'completion' });
  expect(deepText(node.querySelector('.completion-defaults'))).toContain('读取时设备默认');
  expect(node.querySelector('.completion-worker')).toBe(row);
  expect(reads.filter(row => row.path.endsWith('/api/hooks'))).toHaveLength(2);
});

test('retained feature re-reads authorization after an inactive save settles, rather than reusing a stale revision', async () => {
  await openProjectAutomation({ feature: 'completion' });
  const node = ui.automationPage.nodes.get('completion'); let release;
  intercept = (_path, body) => body?.method === 'worker.completion' ? new Promise(resolve => { release = resolve; }) : null;
  const saving = choice(node, 7, 'merge').onclick(); await until(() => release);
  await openProjectAutomation();
  currentPage = page([worker(7, { hooks: { revision: 'saved-revision', completion: completion('merge') } })]);
  release(json({ worker_id: 7, revision: 'saved-revision', completion: completion('merge'), mounts: [] })); await saving;
  expect(choice(node, 7, 'off').getAttribute('aria-pressed')).toBe('true');
  expect(dom.location.hash).toBe('#hooks'); expect(actions).toHaveLength(1);
  intercept = null; await openProjectAutomation({ feature: 'completion' });
  expect(choice(node, 7, 'merge').getAttribute('aria-pressed')).toBe('true');
  await choice(node, 7, 'off').onclick();
  expect(actions.at(-1).params.expected_revision).toBe('saved-revision');
  expect(button(node, '刷新当前页').disabled).toBe(false);
});

test('leaving during confirmation prevents cross-project authorization and catalogue failure is distinct', async () => {
  const node = await render(); const pending = choice(node, 7, 'accept').onclick();
  dom.location.pathname = '/p/2222222222222222/';
  await dialogButton(dom, '授权自动验收').onclick(); await pending; expect(actions).toHaveLength(0); node.dispose();
  intercept = path => path.endsWith('/api/hooks') ? Promise.reject(new Error('catalogue offline')) : null;
  const next = await render(null); expect(deepText(next)).toContain('设备默认读取失败'); expect(next.querySelector('.completion-worker')).toBeTruthy(); next.dispose();
});
