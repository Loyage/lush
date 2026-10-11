import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
const P = 'aaaaaaaaaaaaaaaa', Q = 'bbbbbbbbbbbbbbbb';
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
let config, projects, connections, requests, intercept, serial = 0;
const scope = { selected: 'device', source: 'device', project_override: false };
const clone = value => structuredClone(value);
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null;
  requests.push({ path, method: options.method || 'GET', body });
  const intercepted = intercept?.(path, options, body); if (intercepted) return intercepted;
  if (path === '/api/host') return Response.json({ mode: 'bound', projects, restart_supported: false });
  if (path === '/api/host/projects') return Response.json({ projects: clone(projects) });
  if (path === '/api/host/dashboard') {
    if (options.method === 'POST') {
      if (body.expected_revision !== config.revision) return Response.json({ error: 'revision changed' }, { status: 400 });
      const { expected_revision, ...patch } = body; config = { ...config, ...clone(patch), revision: `r${++serial}` };
    }
    return Response.json(clone(config));
  }
  if (path === '/api/host/settings/agent/connections?scope=device') return Response.json({ connections: clone(connections), configuration_scope: scope });
  if (path === '/api/host/settings/action') return Response.json({ connections: clone(connections), configuration_scope: scope });
  if (/^\/api\/host\/projects\/\w+\/appearance$/.test(path)) return Response.json({ id: path.split('/')[4], appearance: null });
  if (/^\/p\/\w+\/api\/notices\?/.test(path)) return Response.json({ notices: [], has_more: false });
  return Response.json({ error: `not mocked: ${path}` }, { status: 404 });
} });
afterAll(() => dom.restore());
const { openProjectOverview, openProjectManager } = await import('../../src/ui/web/assets/project-picker.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const button = label => dom.node('detail').querySelectorAll('button').find(node => node.textContent === label);
const writes = () => requests.filter(entry => entry.method === 'POST');
const input = (key, value) => dom.node('detail').querySelectorAll('input').find(node => node.dataset[key] === value);
const change = (node, checked) => { node.checked = checked; node.onchange(); };
const observation = { status: 'available', source: 'usage_api', checked_at: '2026-10-01T00:00:00.000Z', resources: [
  { id: 'cash', kind: 'balance', scope: 'account', label: '现金', unit: 'USD', remaining: 12, total: null, used: null } ] };
beforeEach(() => {
  serial = 0; config = { version: 2, revision: 'initial', cards: [{ type: 'account', connection_id: A }], hidden_projects: [], layout: [], content: [] };
  projects = [{ id: P, name: '项目A', project: '/fixture/a', running: true }, { id: Q, name: '项目B', project: '/fixture/b', running: false }];
  connections = [A, B].map((id, i) => ({ id, label: `账户${i + 1}`, provider: 'deepseek', enabled: true, observation }));
  requests = []; intercept = null; dom.node('detail').replaceChildren();
});

test('总览没有标题与介绍，页面和每卡有设置，进入只读且管理页不读取总览设置', async () => {
  await openProjectOverview({ push: false }); const panel = dom.node('detail');
  expect(panel.querySelector('h1')).toBeNull(); expect(dom.node('view-toolbar').hidden).toBe(true);
  expect(deepText(panel)).not.toContain('YOUR WORKSPACE'); expect(deepText(panel)).not.toContain('全局总览');
  expect(panel.querySelector('.dashboard-settings-open')).not.toBeNull();
  expect(panel.querySelectorAll('.dashboard-card-settings')).toHaveLength(3);
  expect(button('刷新全部')).not.toBeUndefined(); expect(writes()).toHaveLength(0);
  expect(panel.querySelector('.project-order')).toBeNull(); expect(panel.querySelector('.workbench-service-restart')).toBeNull();
  requests = []; await openProjectManager({ push: false });
  expect(dom.node('view-toolbar').hidden).toBe(false);
  expect(dom.node('detail').querySelector('.dashboard-settings-panel')).toBeNull();
  expect(requests.some(entry => entry.path === '/api/host/dashboard')).toBe(false);
});

test('总览保存项目与账户选择，重进从设备重读；省略布局和内容不被清空', async () => {
  config.layout = [{ id: P, x: 0, y: 0, w: 4, h: 16 }]; config.content = [{ id: P, sections: ['shortcuts'] }];
  await openProjectOverview({ push: false }); await dom.node('detail').querySelector('.dashboard-settings-open').onclick();
  change(input('projectId', Q), false); change(input('connectionId', B), true); await button('保存').onclick();
  expect(config.hidden_projects).toEqual([Q]); expect(config.cards.map(card => card.connection_id)).toEqual([A, B]);
  expect(config.layout).toEqual([{ id: P, x: 0, y: 0, w: 4, h: 16 }]); expect(config.content).toEqual([{ id: P, sections: ['shortcuts'] }]);
  expect(writes()).toHaveLength(1); expect(Object.keys(writes()[0].body).sort()).toEqual(['cards', 'expected_revision', 'hidden_projects']);
  await openProjectOverview({ push: false });
  expect(dom.node('detail').querySelectorAll('.project-board-card').map(node => node.dataset.projectId).sort()).toEqual([P, `account:${A}`, `account:${B}`].sort());
});

test('每卡内容设置独立共享，空内容保留名称和设置按钮而不保留模块', async () => {
  await openProjectOverview({ push: false });
  const card = dom.node('detail').querySelector(`[data-project-id="${P}"]`);
  await card.querySelector('.dashboard-card-settings').onclick();
  expect(dom.document.activeElement).toBe(dom.node('detail').querySelector('.dashboard-settings-panel'));
  for (const control of dom.node('detail').querySelectorAll('input')) change(control, false);
  await button('保存').onclick(); expect(config.content).toEqual([{ id: P, sections: [] }]);
  const next = dom.node('detail').querySelector(`[data-project-id="${P}"]`);
  expect(deepText(next)).toContain('项目A'); expect(next.querySelector('.project-dashboard-content').children).toHaveLength(0);
  expect(next.querySelector('.dashboard-card-settings')).not.toBeNull();
  expect(dom.document.activeElement).toBe(next.querySelector('.dashboard-card-settings'));
  await openProjectOverview({ push: false });
  expect(dom.node('detail').querySelector(`[data-project-id="${P}"]`).querySelector('.project-dashboard-messages')).toBeNull();
});

test('全局刷新只查询摆放账户，单卡只查自己，且离线项目不读消息或启动', async () => {
  await openProjectOverview({ push: false }); expect(writes()).toHaveLength(0);
  requests = []; await button('刷新全部').onclick();
  expect(writes().map(entry => entry.body.method)).toEqual(['agent.connections.query']);
  expect(writes()[0].body.params).toEqual({ id: A, scope: 'device' });
  expect(requests.some(entry => entry.path.startsWith(`/p/${Q}/api/notices`))).toBe(false);
  expect(requests.some(entry => /projects\/start|host\/select/.test(entry.path))).toBe(false);
  expect(requests.at(-1).method).toBe('GET');
  config.cards.push({ type: 'account', connection_id: B }); await openProjectOverview({ push: false });
  requests = []; const account = dom.node('detail').querySelector(`[data-project-id="account:${B}"]`);
  const refresh = account.querySelectorAll('button').find(node => node.textContent === '刷新'); expect(refresh).not.toBeUndefined();
  await refresh.onclick(); expect(writes().map(entry => entry.body.params.id)).toEqual([B]);
});

test('布局键盘编辑只在保存时写设备，取消恢复且保留隐藏卡片坐标，信息刷新不丢布局草稿', async () => {
  config.hidden_projects = [Q]; config.layout = [{ id: Q, x: 0, y: 8, w: 4, h: 12 }];
  await openProjectOverview({ push: false }); await button('编辑布局').onclick();
  const handle = dom.node('detail').querySelector(`[data-project-id="${P}"]`).querySelector('.project-board-handle');
  expect(handle.hidden).toBe(false);
  handle.onkeydown({ key: 'ArrowDown', preventDefault() {} });
  expect(writes()).toHaveLength(0); await button('取消布局').onclick(); expect(config.layout).toHaveLength(1);
  await button('编辑布局').onclick();
  dom.node('detail').querySelector(`[data-project-id="${P}"]`).querySelector('.project-board-handle').onkeydown({ key: 'ArrowDown', preventDefault() {} });
  await button('刷新全部').onclick(); const before = writes().length;
  await button('保存布局').onclick(); expect(writes()).toHaveLength(before + 1);
  expect(config.layout.find(item => item.id === P).y).toBe(1);
  expect(config.layout.find(item => item.id === Q)).toEqual({ id: Q, x: 0, y: 8, w: 4, h: 12 });
  expect(dom.node('detail').querySelector(`[data-project-id="${P}"]`).querySelector('.project-board-handle').hidden).toBe(true);
  await openProjectOverview({ push: false });
  expect(dom.node('detail').querySelector(`[data-project-id="${P}"]`).style.getPropertyValue('grid-row')).toBe('2 / span 16');
});

test('全局刷新在途禁用单卡及设置按钮，重复点击不重复查询，完成后恢复', async () => {
  await openProjectOverview({ push: false }); requests = [];
  let release; const delayed = new Promise(resolve => { release = resolve; });
  intercept = path => path === '/api/host/settings/action' ? delayed : null;
  const pending = button('刷新全部').onclick(); await Bun.sleep(0);
  const control = dom.node('detail').querySelector('.dashboard-account-refresh');
  expect(control.disabled).toBe(true); expect(control.parentNode.dataset.help).toContain('请等待');
  expect(dom.node('detail').querySelector('.dashboard-settings-open').disabled).toBe(true);
  await button('刷新全部').onclick(); expect(writes()).toHaveLength(1);
  release(Response.json({ connections, configuration_scope: scope })); await pending;
  expect(dom.node('detail').querySelector('.dashboard-account-refresh').disabled).toBe(false);
});

test('冲突保留草稿，失败重读也保留，信息刷新不拿新revision提交旧表单', async () => {
  await openProjectOverview({ push: false }); await dom.node('detail').querySelector('.dashboard-settings-open').onclick();
  change(input('connectionId', B), true); config = { ...config, revision: 'other-client', content: [{ id: P, sections: [] }] };
  await button('刷新全部').onclick();
  expect(input('connectionId', B).checked).toBe(true);
  await button('保存').onclick(); expect(config.cards).toHaveLength(1);
  expect(input('connectionId', B).checked).toBe(true); expect(deepText(dom.node('detail'))).toContain('编辑已保留');
  const before = writes().length; await button('保存').onclick(); expect(writes()).toHaveLength(before);
  intercept = path => path === '/api/host/dashboard' ? Response.json({ error: 'broken' }, { status: 500 }) : null;
  await button('重新读取设置').onclick(); expect(input('connectionId', B).checked).toBe(true);
  intercept = null; await button('重新读取设置').onclick(); expect(input('connectionId', B).checked).toBe(false);
  expect(button('保存').disabled).toBe(false);
});

test('读取失败明确未知且保留旧项目入口，不展示过期成功账户值；换页晚回复不回填', async () => {
  await openProjectOverview({ push: false });
  intercept = path => path === '/api/host/projects' || path === '/api/host/settings/agent/connections?scope=device'
    ? Response.json({ error: 'offline' }, { status: 503 }) : null;
  await button('刷新全部').onclick();
  expect(deepText(dom.node('detail'))).toContain('当前状态未确认');
  const account = dom.node('detail').querySelector('.dashboard-account-card');
  expect(account.querySelectorAll('.dashboard-account-metric')).toHaveLength(0);
  intercept = null;
  let resolve; const deferred = new Promise(done => { resolve = done; });
  intercept = path => path === '/api/host/dashboard' ? deferred : null;
  const pending = button('刷新全部').onclick(); await Bun.sleep(0);
  activateDetailView({ view: 'settings', push: false }); dom.node('detail').replaceChildren();
  resolve(Response.json(config)); await pending;
  expect(dom.node('detail').dataset.view).toBe('settings'); expect(dom.node('detail').querySelector('.project-board')).toBeNull();
});
