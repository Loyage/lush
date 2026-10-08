import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld();
let intercept = null;
const dom = installDom({ fetch: (url, options) => intercept?.(String(url), options) ?? world.fetchImpl(url, options) });
const { ui } = await import('../../src/ui/web/assets/state.js');
const { openDocs } = await import('../../src/ui/web/assets/docs.js');
const { detail } = await import('../../src/ui/web/assets/navigate.js');
const { renderTree } = await import('../../src/ui/web/assets/render-tree.js');
const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
const { ROLE } = await import('../../src/ui/web/assets/format.js');
const json = data => ({ ok: true, json: async () => data?.connections ? { ...data, configuration_scope: { selected: 'device', source: 'device', project_override: false } } : data });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const { boot } = await import('../../src/ui/web/assets/app.js');
dom.node('side-nav').replaceChildren();
await boot();
afterAll(() => dom.restore());

test('左栏只做导航：任务索引在右侧成为独立页面，任务详情与浏览器后退仍可往返', async () => {
  const taskNav = dom.node('side-nav').querySelector('[data-side="tasks"]');
  await taskNav.onclick();

  expect(dom.location.hash).toBe('#workers');
  expect(dom.node('resource-panels').hidden).toBe(false);
  expect(dom.node('detail').hidden).toBe(true);
  expect(dom.node('side-tasks').hidden).toBe(false);
  expect(dom.node('side-notices').hidden).toBe(true);
  expect(dom.node('view-title').textContent).toBe('Worker 列表');
  expect(dom.node('tasks').querySelector('[data-id="1"]')).toBeTruthy();

  await dom.node('tasks').querySelector('[data-id="1"]').onclick();
  expect(dom.location.hash).toBe('#worker-1');
  expect(dom.node('resource-panels').hidden).toBe(true);
  expect(dom.node('detail').hidden).toBe(false);
  expect(dom.node('view-title').textContent).toBe('Worker #1');

  // 用 hashchange 模拟浏览器后退：回到任务页，而不是把任务列表塞回左栏。
  dom.location.hash = '#workers';
  await dom.fire('hashchange');
  expect(dom.node('resource-panels').hidden).toBe(false);
  expect(dom.node('side-tasks').hidden).toBe(false);
  expect(dom.node('detail').hidden).toBe(true);
});

test('右侧固定返回按钮在没有原生 history.back 的宿主里安全回落到概览', async () => {
  await dom.node('side-nav').querySelector('[data-side="tasks"]').onclick();
  expect(dom.node('view-title').textContent).toBe('Worker 列表');
  await dom.node('view-back').onclick();
  expect(dom.node('detail').hidden).toBe(false);
  expect(dom.node('resource-panels').hidden).toBe(true);
  expect(dom.node('detail').dataset.view).toBe('overview');
  expect(deepText(dom.node('detail'))).toContain('项目概览');
});

const navEntries = () => [
  ...['overview', 'task-graph', 'agent-status', 'model-sources', 'settings', 'docs'].map(id => [id, dom.node(`${id}-open`)]),
  ...[...ui.navButtons.entries()],
];
const routeHash = id => id === 'overview' ? '' : `#${id === 'tasks' ? 'workers' : id === 'task-graph' ? 'worker-graph' : id}`;
function expectSelected(id) {
  expect(navEntries().filter(([, node]) => node.classList.contains('selected')).map(([key]) => key)).toEqual([id]);
  expect(navEntries().filter(([, node]) => node.getAttribute('aria-current') === 'page').map(([key]) => key)).toEqual([id]);
}

test('所有页面平级、唯一选中；重复点击、hash 后退与轮询保持画布一致', async () => {
  intercept = url => url === '/api/docs' ? Promise.resolve(json({ docs: [] })) : null;
  try {
    for (const [id, node] of navEntries()) {
      dom.node('sidebar').classList.add('mobile-open');
      await node.onclick();
      expectSelected(id);
      expect(dom.location.hash).toBe(routeHash(id));
      expect(dom.node('sidebar').classList.contains('mobile-open')).toBe(false);
      const pushes = dom.pushed();
      await node.onclick();
      expectSelected(id);
      expect(dom.pushed()).toBe(pushes);
      await dom.intervalFor(1500)();
      expectSelected(id);
      if (ui.indexOpen) expect(dom.node(`side-${id}`).hidden).toBe(false);
      else expect(dom.node('detail').dataset.view).toBe(id);
    }
    for (const id of ['task-graph', 'agent-status', 'model-sources', 'settings', 'notices', 'tasks', 'docs', 'overview']) {
      dom.location.hash = routeHash(id);
      await dom.fire('hashchange');
      expectSelected(id);
    }
    await detail(1);
    expectSelected('tasks');
  } finally { intercept = null; }
});

test('来源UUID深链接选择正确详情，来源只读请求迟到不覆盖新页面', async () => {
  const connectionId = '12345678-1234-1234-1234-123456789abc';
  const previous = world.state.agentConnections;
  world.state.agentConnections = { ...previous, connections: [{ id: connectionId, label: '指定 API', provider: 'deepseek',
    auth_type: 'api_key', endpoint: 'https://api.deepseek.com', enabled: true, models: ['flash'],
    credential: { status: 'configured' }, consumers: [] }] };
  try {
    await dom.node('home').onclick(); dom.location.hash = `#model-source-${connectionId}`; await dom.fire('hashchange');
    expectSelected('model-sources'); expect(dom.node('view-title').textContent).toBe('模型来源');
    const cards = dom.node('detail').querySelectorAll('.agent-connection-card').filter(node => !node.hidden);
    expect(cards.map(node => node.dataset.connectionId)).toEqual([connectionId]);
    expect(dom.location.hash).toBe(`#model-source-${connectionId}`);
    await dom.intervalFor(1500)(); expectSelected('model-sources');
    await dom.node('home').onclick();
    const pending = deferred(), started = deferred();
    intercept = url => url === '/api/agent/connections?scope=device' ? (started.resolve(), pending.promise) : null;
    const opening = dom.node('model-sources-open').onclick(); await started.promise;
    await dom.node('settings-open').onclick(); pending.resolve(json(world.state.agentConnections)); await opening;
    expectSelected('settings'); expect(dom.node('detail').querySelector('.model-source-layout')).toBeNull();
  } finally { intercept = null; world.state.agentConnections = previous; }
});

test('概览切换不依赖 revision 变化，轮询忙或断网时也立即显示缓存', async () => {
  await dom.node('home').onclick();
  ui.lastSnapshot.revision = 'stable';
  const pending = deferred();
  intercept = url => url.startsWith('/api/overview') ? pending.promise : null;
  const poll = dom.intervalFor(1500)();
  await dom.node('settings-open').onclick();
  await dom.node('overview-open').onclick();
  expect(deepText(dom.node('detail'))).toContain('项目概览');
  expectSelected('overview');
  pending.resolve(json({ unchanged: true, revision: 'stable' }));
  await poll;
  intercept = url => url.startsWith('/api/overview') ? Promise.resolve(json({ unchanged: true, revision: 'stable' })) : null;
  await dom.node('settings-open').onclick();
  await dom.node('overview-open').onclick();
  expect(deepText(dom.node('detail'))).toContain('项目概览');
  intercept = null;
  delete ui.lastSnapshot.revision;
});

test('迟到的 Task 图、文档与任务请求不覆盖新页面；文档 A→B 乱序也安全', async () => {
  await dom.node('home').onclick();
  for (const [path, open] of [
    ['/api/worker-graph', () => dom.node('task-graph-open').onclick()],
    ['/api/docs', () => openDocs()],
    ['/api/worker/1', () => detail(1)],
  ]) {
    const pending = deferred();
    intercept = url => url.split('?')[0] === path ? pending.promise : null;
    const loading = open();
    await dom.node('settings-open').onclick();
    pending.resolve(path === '/api/docs' ? json({ docs: [] }) : await world.fetchImpl(path));
    await loading;
    expectSelected('settings');
    expect(dom.node('detail').dataset.view).toBe('settings');
  }
  const a = deferred(), b = deferred();
  intercept = url => url === '/api/docs' ? Promise.resolve(json({ docs: [{ id: 'a', path: 'a.md' }, { id: 'b', path: 'b.md' }] }))
    : url === '/api/docs/a' ? a.promise : url === '/api/docs/b' ? b.promise : null;
  const first = openDocs('a');
  await Promise.resolve(); await Promise.resolve();
  const second = openDocs('b');
  b.resolve(json({ id: 'b', path: 'b.md', title: '文档 B', content: '最新文档 B' }));
  await second;
  a.resolve(json({ id: 'a', path: 'a.md', title: '文档 A', content: '过期文档 A' }));
  await first;
  expect(deepText(dom.node('detail'))).toContain('文档 B');
  expect(deepText(dom.node('detail'))).not.toContain('过期文档 A');
  expectSelected('docs');
  intercept = null;
});

test('全部现行角色和历史调度类型始终可选，未知类型也不丢失', async () => {
  await dom.node('home').onclick();
  const snapshot = ui.lastSnapshot;
  const tasks = [...Object.keys(ROLE), 'future-role'].map((role, index) => ({
    id: 100 + index, parent_id: null, input_id: null, role, goal: `测试 ${role}`,
    status: 'completed', integration: 'none', updated_at: new Date().toISOString(),
  }));
  ui.lastSnapshot = { ...snapshot, tasks };
  renderTree(ui.lastSnapshot);
  const group = dom.node('task-filters').querySelectorAll('.filter-multi')[1];
  const choices = () => group.querySelectorAll('input').map(node => node.value);
  expect(choices()).toEqual(['all', ...Object.keys(ROLE), 'future-role']);
  const all = group.querySelector('[data-value="all"]').querySelector('input');
  for (const task of tasks) {
    all.checked = true; await all.listeners.change[0]();
    const box = group.querySelector(`[data-value="${task.role}"]`).querySelector('input');
    box.checked = true;
    await box.listeners.change[0]();
    expect(dom.node('tasks').querySelectorAll('.task').map(node => Number(node.dataset.id))).toEqual([task.id]);
  }
  ui.lastSnapshot = snapshot;
  all.checked = true; await all.listeners.change[0]();
  expect(choices()).toEqual(['all', ...Object.keys(ROLE)]);
});

test('任务列表与详情省略通用 agent 角色标签，保留专用角色和 Agent 运行信息', async () => {
  await dom.node('home').onclick();
  const snapshot = ui.lastSnapshot;
  const base = { id: 401, parent_id: 1, input_id: null, role: 'agent', task_kind: 'order',
    goal: '普通任务', status: 'completed', integration: 'none', calls: 0,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  try {
    for (const status of ['paused', 'running', 'completed']) {
      const task = { ...base, status, agent: { id: 'agent#401', active: status === 'running', pid: 1234 } };
      ui.lastSnapshot = { ...snapshot, tasks: [task] };
      renderTree(ui.lastSnapshot);
      const row = dom.node('tasks').querySelector('[data-id="401"]');
      expect(row.querySelector('.role-badge')).toBeNull();
      expect(deepText(row)).not.toContain('agent');
      renderDetail(task, null, null, null);
      expect(dom.node('detail').querySelector('.head').querySelector('.role-badge')).toBeNull();
      expect(deepText(dom.node('detail').querySelector('.breadcrumb'))).toContain('Worker #401');
      expect(deepText(dom.node('detail').querySelector('.head'))).toContain(status === 'running'
        ? 'agent agent#401 · pid 1234' : 'agent agent#401 · 空闲');
    }
    for (const role of ['worker', 'research', 'future-role']) {
      const task = { ...base, role, task_kind: null };
      ui.lastSnapshot = { ...snapshot, tasks: [task] };
      renderTree(ui.lastSnapshot);
      expect(dom.node('tasks').querySelector('.role-badge').textContent).toBe(ROLE[role] || role);
      renderDetail(task, null, null, null);
      expect(dom.node('detail').querySelector('.head').querySelector('.role-badge').textContent).toBe(ROLE[role] || role);
    }
  } finally {
    ui.lastSnapshot = snapshot;
    renderTree(snapshot);
    await dom.node('home').onclick();
  }
});

test('任务列表：角色胶囊带 role-<role> 类，快速路由任务整行标记并显示徽章', async () => {
  await dom.node('home').onclick();
  const snapshot = ui.lastSnapshot;
  ui.lastSnapshot = { ...snapshot, tasks: [
    { id: 301, parent_id: null, input_id: 1, role: 'worker', goal: '路由出来的任务', status: 'running', integration: 'none', route: true, updated_at: new Date().toISOString() },
    { id: 302, parent_id: null, input_id: 2, role: 'verifier', goal: '普通验收任务', status: 'completed', integration: 'none', route: false, updated_at: new Date().toISOString() },
  ] };
  try {
    renderTree(ui.lastSnapshot);
    const routed = dom.node('tasks').querySelector('[data-id="301"]');
    const plain = dom.node('tasks').querySelector('[data-id="302"]');
    expect(routed.classList.contains('route-flagged')).toBe(true);
    expect(routed.querySelector('.role-badge').className).toContain('role-worker');
    expect(routed.querySelector('.route-badge').textContent).toContain('快速路由');
    expect(plain.classList.contains('route-flagged')).toBe(false);
    expect(plain.querySelector('.role-badge').className).toContain('role-verifier');
    expect(plain.querySelector('.route-badge')).toBeNull();
  } finally {
    ui.lastSnapshot = snapshot;
    renderTree(ui.lastSnapshot);
  }
});

test('直接链接启动复用同一路由，重复 boot 不复制导航', async () => {
  for (const id of ['task-graph', 'agent-status', 'settings', 'tasks']) {
    dom.location.hash = routeHash(id);
    await boot();
    expectSelected(id);
    expect(dom.node('side-nav').querySelectorAll('.nav-item')).toHaveLength(2);
  }
});

test('Worker 公开深链接使用新地址，内部页面与 DOM 身份不迁移；旧 Task hash 仅回概览', async () => {
  const reads = [];
  intercept = url => {
    reads.push(url);
    return url.split('?')[0] === '/api/worker-graph' ? Promise.resolve(json({ total: 0, nodes: [], edges: [] })) : null;
  };
  try {
    for (const [hash, view, selected] of [
      ['#workers', 'tasks', 'tasks'], ['#worker-graph', 'task-graph', 'task-graph'], ['#worker-1', 'task', 'tasks'],
    ]) {
      dom.location.hash = hash;
      await boot();
      expect(dom.location.hash).toBe(hash);
      expect(ui.view.id).toBe(view);
      expectSelected(selected);
    }
    expect(ui.selected).toBe(1);
    expect(dom.node('detail').dataset.taskId).toBe('1');
    expect(dom.node('detail').dataset.view).toBe('task');
    expect(dom.node('tasks')).toBeTruthy();
    expect(reads).toContain('/api/worker/1');
    expect(reads).toContain('/api/worker-graph?details=0');
    expect(reads.some(url => /^\/api\/tasks?(?:\/|\?|$|-graph)/.test(url))).toBe(false);
    const workerReads = () => reads.filter(url => url.startsWith('/api/worker')).length;
    for (const hash of ['#task-1', '#task-graph', '#tasks']) {
      const before = workerReads();
      dom.location.hash = hash;
      await dom.fire('hashchange');
      expect(ui.view.id).toBe('overview');
      expectSelected('overview');
      expect(dom.location.hash).toBe('');
      expect(workerReads()).toBe(before);
    }
    expect(ROLE.worker).toBe('执行');
  } finally { intercept = null; }
});

test('编号深链接查找真实身份、缺失时明确报错，迟到查找不抢走当前页面', async () => {
  const reads = [];
  intercept = url => {
    reads.push(url);
    if (url === '/api/worker-lookup?number=W141-1') return json({ id: 1, worker_number: 'W141-1' });
    if (url === '/api/worker-lookup?number=W999') return { ok: false, json: async () => ({ error: 'worker W999 not found' }) };
    return null;
  };
  try {
    dom.location.hash = '#worker-number-W141-1';
    const pushed = dom.pushed();
    await boot();
    expect(reads).toContain('/api/worker-lookup?number=W141-1');
    expect(reads).toContain('/api/worker/1');
    expect(reads).not.toContain('/api/worker/141');
    expect(ui.selected).toBe(1);
    expect(dom.location.hash).toBe('#worker-1');
    expect(dom.pushed()).toBe(pushed); // canonicalization must not create a Back loop
    dom.location.hash = '#worker-number-W999';
    await dom.fire('hashchange');
    expect(dom.node('error').textContent).toContain('worker W999 not found');
    expect(ui.selected).toBe(1);
    const pending = deferred();
    intercept = url => url === '/api/worker-lookup?number=W141-1' ? pending.promise : null;
    dom.location.hash = '#worker-number-W141-1';
    const opening = dom.fire('hashchange');
    dom.location.hash = '#workers'; await dom.fire('hashchange');
    pending.resolve(json({ id: 1, worker_number: 'W141-1' })); await opening;
    expect(dom.location.hash).toBe('#workers'); expect(ui.view.id).toBe('tasks');
  } finally { intercept = null; }
});

test('前端 mock 只接受 worker HTTP/RPC，不保留 task 接口别名；响应内字段仍为 task_id', async () => {
  const isolated = makeWorld();
  expect((await isolated.fetchImpl('/api/worker/1')).ok).toBe(true);
  for (const url of ['/api/task/1', '/api/task/1/usage', '/api/tasks?scope=all', '/api/task-graph']) {
    expect((await isolated.fetchImpl(url)).status).toBe(404);
  }
  const oldAction = await isolated.fetchImpl('/api/action', { body: JSON.stringify({ method: 'task.auto_merge', params: { id: 1, enabled: true } }) });
  expect(oldAction.status).toBe(404);
  expect(isolated.state.actions).toHaveLength(0);
  const setting = await isolated.fetchImpl('/api/action', { body: JSON.stringify({ method: 'worker.auto_merge', params: { id: 1, enabled: true } }) });
  expect(await setting.json()).toMatchObject({ task_id: 1, auto_merge: { enabled: true } });
});

test('Worker 详情按本地连接列表显示来源名称，完整响应形状也能解开', async () => {
  const original = world.state.agentConnections.connections;
  const id = '44444444-4444-4444-8444-444444444444';
  world.state.agentConnections.connections = [{ id, label: '我的订阅来源', provider: 'openai-compatible',
    endpoint: 'https://models.example/v1', enabled: true, auth_type: 'api_key', models: [], credential: { status: 'configured' } }];
  const base = await (await world.fetchImpl('/api/worker/1')).json();
  intercept = (url, options) => url === '/api/worker/1' ? json({ ...base, task_kind: 'order',
    model_selection: { agent: 'pi', connection_id: id, model: 'openai-compatible/model-1', thinking: '', explicit: true } }) : null;
  try {
    await detail(1);
    // The main Worker now opens before its independent connection-name read completes.
    for (let i = 0; i < 12; i++) await Promise.resolve();
    const text = deepText(dom.node('detail'));
    expect(text).toContain('下一次配置：pi → 我的订阅来源 → openai-compatible/model-1');
    expect(text).not.toContain(id);
  } finally { intercept = null; world.state.agentConnections.connections = original; }
});
