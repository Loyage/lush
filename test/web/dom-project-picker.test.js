import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';

let state = { mode: 'host', project: null, last_project: null, last_project_id: null, projects: [], capabilities: { project_control: true } };
const requests = [];
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '');
  requests.push({ path, options });
  if (path === '/api/host/select') return Response.json({ id: ID });
  if (path === '/api/host/projects') return Response.json({ projects: state.projects });
  if (path === '/api/host') return Response.json(state);
  if (path === '/api/host/projects/start' || path === '/api/host/projects/stop' || path === '/api/host/remove') return Response.json({ ok: true });
  return Response.json({ error: 'not mocked' }, { status: 404 });
} });
afterAll(() => dom.restore());

const picker = await import('../../src/ui/web/assets/project-picker.js');
const ID = 'a1b2c3d4e5f60718';
const row = { id: ID, project: '/tmp/demo', name: 'demo', connected: false, running: false, last: true, error: null };

test('根路径不再按 last_project 强制跳转，先启动完整工作台 shell', async () => {
  state = { ...state, last_project: '/tmp/demo', last_project_id: ID, projects: [row] };
  globalThis.location.pathname = '/'; globalThis.location.hash = '#worker-3';
  let replaced = null; globalThis.location.replace = url => { replaced = url; };
  expect(await picker.ensureProject()).toBe(true);
  expect(replaced).toBeNull();
  expect(picker.workbenchStatus().projectUsable).toBe(false);
  expect(requests.every(entry => entry.path.startsWith('/api/host'))).toBe(true);
  delete globalThis.location.replace;
});

test('项目管理画在主内容，不再 inert 应用或显示阻塞 gate', async () => {
  state = { ...state, last_project: null, last_project_id: null, projects: [row] };
  globalThis.location.pathname = '/'; globalThis.location.hash = '';
  await picker.ensureProject();
  await picker.openProjectManager({ push: false });
  expect(dom.node('project-app').getAttribute('inert')).toBeNull();
  expect(dom.node('detail').dataset.view).toBe('projects');
  expect(deepText(dom.node('detail'))).toContain('项目管理');
  expect(dom.node('detail').querySelector('a.project-open').target).toBe('_blank');
});

test('新增项目同步预约窗口，异步 select 后不清空当前输入', async () => {
  state = { ...state, projects: [] };
  await picker.openProjectManager({ push: false });
  const panel = dom.node('detail');
  const form = panel.querySelector('form.project-manager-form');
  const input = form.querySelector('input'); input.value = '/tmp/new-project';
  const popup = { location: { href: 'about:blank' }, close() {}, opener: {} };
  let opens = 0; dom.window.open = () => { opens += 1; return popup; };
  form.onsubmit({ preventDefault() {} });
  await Bun.sleep(0); await Bun.sleep(0);
  expect(opens).toBe(1);
  expect(popup.location.href).toBe(`/p/${ID}/`);
  expect(input.value).toBe('/tmp/new-project');
  const select = requests.find(entry => entry.path === '/api/host/select');
  expect(JSON.parse(select.options.body)).toEqual({ project: '/tmp/new-project' });
});

test('桌面拦截空白弹窗后仍用已校验的项目地址打开独立窗口，已登记项目只显式 start', async () => {
  state = { ...state, projects: [row] }; globalThis.location.pathname = '/';
  await picker.ensureProject(); await picker.openProjectManager({ push: false });
  const oldOpen = dom.window.open, oldDesktop = dom.window.lushDesktop;
  const opened = [], before = requests.length;
  dom.window.open = (...args) => { opened.push(args); return null; };
  dom.window.lushDesktop = { platform: 'darwin', mode: 'local' };
  try {
    const link = dom.node('detail').querySelector('a.project-open');
    link.onclick({ preventDefault() {} });
    await Bun.sleep(0); await Bun.sleep(0);
    expect(opened.some(([target]) => target === `/p/${ID}/`)).toBe(true);
    expect(requests.slice(before).filter(entry => entry.options.method === 'POST').map(entry => entry.path)).toEqual(['/api/host/projects/start']);
    expect(globalThis.location.pathname).toBe('/');
  } finally { dom.window.open = oldOpen; dom.window.lushDesktop = oldDesktop; }
});

test('浏览器阻止弹窗后提供真实链接，不替换当前页面或反复启动', async () => {
  await picker.openProjectManager({ push: false });
  const oldOpen = dom.window.open; dom.window.open = () => null;
  try {
    const link = dom.node('detail').querySelector('a.project-open');
    link.onclick({ preventDefault() {} });
    await Bun.sleep(0); await Bun.sleep(0);
    expect(link.onclick).toBeNull();
    expect(link.href).toBe(`/p/${ID}/`);
    expect(link.target).toBe('_blank');
    expect(globalThis.location.pathname).toBe('/');
  } finally { dom.window.open = oldOpen; }
});

test('已移除项目地址保留 shell，不静默绑定或回落其它项目', async () => {
  state = { ...state, projects: [row] };
  globalThis.location.pathname = '/p/ffffffffffffffff/';
  expect(await picker.ensureProject()).toBe(true);
  expect(picker.workbenchStatus().projectUsable).toBe(false);
  expect(globalThis.location.pathname).toBe('/p/ffffffffffffffff/');
  globalThis.location.pathname = '/';
});

test('离线环境地址请求环境自己的 Host API，不回落入口本地项目', async () => {
  const environment = 'c'.repeat(32), before = requests.length;
  globalThis.location.pathname = `/e/${environment}/p/${ID}/`;
  expect(await picker.ensureProject()).toBe(true);
  expect(picker.workbenchStatus()).toMatchObject({ environment, project: ID, projectUsable: false });
  expect(requests.slice(before).map(entry => entry.path)).toEqual([`/e/${environment}/api/host`]);
  expect(requests.slice(before).some(entry => entry.path === '/api/host')).toBe(false);
  globalThis.location.pathname = '/';
});
