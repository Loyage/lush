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
const { ROLE } = await import('../../src/ui/web/assets/format.js');
const json = data => ({ ok: true, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const { boot } = await import('../../src/ui/web/assets/app.js');
dom.node('side-nav').replaceChildren();
await boot();
afterAll(() => dom.restore());

test('左栏只做导航：任务索引在右侧成为独立页面，任务详情与浏览器后退仍可往返', async () => {
  const taskNav = dom.node('side-nav').querySelector('[data-side="tasks"]');
  await taskNav.onclick();

  expect(dom.location.hash).toBe('#tasks');
  expect(dom.node('resource-panels').hidden).toBe(false);
  expect(dom.node('detail').hidden).toBe(true);
  expect(dom.node('side-tasks').hidden).toBe(false);
  expect(dom.node('side-notices').hidden).toBe(true);
  expect(dom.node('view-title').textContent).toBe('任务列表');
  expect(dom.node('tasks').querySelector('[data-id="1"]')).toBeTruthy();

  await dom.node('tasks').querySelector('[data-id="1"]').onclick();
  expect(dom.location.hash).toBe('#task-1');
  expect(dom.node('resource-panels').hidden).toBe(true);
  expect(dom.node('detail').hidden).toBe(false);
  expect(dom.node('view-title').textContent).toBe('任务 #1');

  // 用 hashchange 模拟浏览器后退：回到任务页，而不是把任务列表塞回左栏。
  dom.location.hash = '#tasks';
  await dom.fire('hashchange');
  expect(dom.node('resource-panels').hidden).toBe(false);
  expect(dom.node('side-tasks').hidden).toBe(false);
  expect(dom.node('detail').hidden).toBe(true);
});

test('右侧固定返回按钮在没有原生 history.back 的宿主里安全回落到概览', async () => {
  await dom.node('side-nav').querySelector('[data-side="intents"]').onclick();
  expect(dom.node('view-title').textContent).toBe('需求记录');
  await dom.node('view-back').onclick();
  expect(dom.node('detail').hidden).toBe(false);
  expect(dom.node('resource-panels').hidden).toBe(true);
  expect(dom.node('detail').dataset.view).toBe('overview');
  expect(deepText(dom.node('detail'))).toContain('项目概览');
});

const navEntries = () => [
  ...['overview', 'graph', 'statistics', 'settings', 'docs'].map(id => [id, dom.node(`${id}-open`)]),
  ...[...ui.navButtons.entries()],
];
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
      expect(dom.location.hash).toBe(id === 'overview' ? '' : `#${id}`);
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
    for (const id of ['graph', 'statistics', 'settings', 'notices', 'tasks', 'intents', 'specs', 'docs', 'overview']) {
      dom.location.hash = id === 'overview' ? '' : `#${id}`;
      await dom.fire('hashchange');
      expectSelected(id);
    }
    await detail(1);
    expectSelected('tasks');
  } finally { intercept = null; }
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

test('迟到的分支、文档与任务请求不覆盖新页面；文档 A→B 乱序也安全', async () => {
  await dom.node('home').onclick();
  for (const [path, open] of [
    ['/api/graph', () => dom.node('graph-open').onclick()],
    ['/api/docs', () => openDocs()],
    ['/api/task/1', () => detail(1)],
  ]) {
    const pending = deferred();
    intercept = url => url === path ? pending.promise : null;
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
  const select = dom.node('task-filters').querySelectorAll('.filter-select')[1];
  expect(select.querySelectorAll('option').map(node => node.value)).toEqual(['all', ...Object.keys(ROLE), 'future-role']);
  for (const task of tasks) {
    select.value = task.role;
    await select.listeners.change[0]();
    expect(dom.node('tasks').querySelectorAll('.task').map(node => Number(node.dataset.id))).toEqual([task.id]);
  }
  ui.lastSnapshot = snapshot;
  select.value = 'all'; await select.listeners.change[0]();
  expect(select.querySelectorAll('option').map(node => node.value)).toEqual(['all', ...Object.keys(ROLE)]);
});

test('任务树：角色胶囊带 role-<role> 类，快速路由任务整行标记并显示徽章', async () => {
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
  for (const id of ['graph', 'statistics', 'settings', 'tasks']) {
    dom.location.hash = `#${id}`;
    await boot();
    expectSelected(id);
    expect(dom.node('side-nav').querySelectorAll('.nav-item')).toHaveLength(4);
  }
});
