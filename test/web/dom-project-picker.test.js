import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';

let state = { mode: 'host', project: null, last_project: null, last_project_id: null, projects: [], capabilities: { project_control: true } };
const requests = [];
let projectListResponse = null;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '');
  requests.push({ path, options });
  if (path === '/api/host/select') return Response.json({ id: ID });
  if (path === '/api/host/projects') return projectListResponse?.() ?? Response.json({ projects: state.projects });
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
  expect(deepText(dom.node('detail'))).toContain('后台总览');
  expect(dom.node('detail').querySelector('a.project-open').target).toBe('_blank');
});

test('后台总览展示真实进程摘要及指令输入，不再提供处理消息按钮，刷新不丢草稿或另起后台', async () => {
  state = { ...state, projects: [{ ...row, running: true, summary: { pid: 1234, agents_total: 2, notices: 3, pending_merges: 1 } }] };
  await picker.openProjectManager({ push: false });
  const panel = dom.node('detail'); expect(deepText(panel)).toContain('PID 1234'); expect(deepText(panel)).toContain('执行中 2');
  expect(deepText(panel)).toContain('在线后台 1');
  expect(panel.querySelectorAll('a').find(link => link.textContent === '处理消息')).toBeUndefined();
  const slot = panel.querySelector('.project-order'); await slot.querySelector('button').onclick();
  const input = slot.querySelector('textarea'); input.value = '未发送的工作'; input.oninput();
  const before = requests.length; await picker.refreshProjectList();
  expect(panel.querySelector('.project-order')).toBe(slot); expect(slot.querySelector('textarea')).toBe(input); expect(input.value).toBe('未发送的工作');
  state.projects[0].running = false; await picker.refreshProjectList();
  expect(input.value).toBe('未发送的工作'); expect(slot.querySelector('.project-order-form').querySelectorAll('button').every(control => control.disabled)).toBe(true);
  expect(requests.slice(before).every(request => !request.options.method || request.options.method === 'GET')).toBe(true);
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

test('已登记项目显式 start 并在独立标签打开，修饰点击保留真实链接', async () => {
  state = { ...state, projects: [row] }; globalThis.location.pathname = '/';
  await picker.ensureProject(); await picker.openProjectManager({ push: false });
  const oldOpen = dom.window.open;
  const popup = { location: { href: 'about:blank' }, opener: {} }, before = requests.length;
  let opens = 0;
  dom.window.open = () => { opens++; return popup; };
  try {
    const link = dom.node('detail').querySelector('a.project-open');
    link.onclick({ ctrlKey: true, preventDefault() { throw new Error('modifier click intercepted'); } });
    expect(opens).toBe(0);
    link.onclick({ preventDefault() {} });
    await Bun.sleep(0); await Bun.sleep(0);
    expect(opens).toBe(1);
    expect(popup.location.href).toBe(`/p/${ID}/`);
    expect(popup.opener).toBeNull();
    expect(requests.slice(before).filter(entry => entry.options.method === 'POST').map(entry => entry.path)).toEqual(['/api/host/projects/start']);
    expect(globalThis.location.pathname).toBe('/');
  } finally { dom.window.open = oldOpen; }
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

test('项目页显式刷新状态，保留目录输入，离页不读取或应用迟到结果', async () => {
  state = { ...state, projects: [row] }; globalThis.location.pathname = '/';
  await picker.ensureProject(); await picker.openProjectManager({ push: false });
  const panel = dom.node('detail');
  const input = panel.querySelector('.project-manager-form').querySelector('input');
  input.value = '/tmp/not-yet-opened';
  const refresh = panel.querySelectorAll('button').find(button => button.textContent === '刷新项目状态');
  state = { ...state, projects: [{ ...row, running: true }] };
  await refresh.onclick();
  expect(deepText(panel)).toContain('运行中');
  expect(input.value).toBe('/tmp/not-yet-opened');
  expect(requests.at(-1)).toMatchObject({ path: '/api/host/projects', options: {} });

  const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
  let resolve;
  projectListResponse = () => new Promise(done => { resolve = done; });
  const pending = refresh.onclick();
  activateDetailView({ view: 'docs', title: '帮助文档', push: false });
  resolve(Response.json({ projects: [] }));
  await pending;
  expect(deepText(panel)).toContain('运行中');
  const before = requests.length;
  await picker.refreshProjectList();
  expect(requests.length).toBe(before);
  projectListResponse = null;
});

test('项目页刷新失败保留列表和输入，可显式重试恢复空态', async () => {
  state = { ...state, projects: [row] };
  await picker.openProjectManager({ push: false });
  const panel = dom.node('detail');
  const input = panel.querySelector('.project-manager-form').querySelector('input');
  input.value = '/tmp/keep-me';
  projectListResponse = () => Response.json({ error: 'offline' }, { status: 503 });
  await picker.refreshProjectList();
  expect(panel.querySelectorAll('.project-item')).toHaveLength(1);
  expect(deepText(panel)).toContain('项目列表刷新失败');
  expect(input.value).toBe('/tmp/keep-me');
  projectListResponse = null;
  state = { ...state, projects: [] };
  await picker.refreshProjectList();
  expect(panel.querySelectorAll('.project-item')).toHaveLength(0);
  expect(deepText(panel)).toContain('还没有项目入口');
  expect(deepText(panel)).not.toContain('项目列表刷新失败');
});

test('已移除项目地址保留 shell，不静默绑定或回落其它项目', async () => {
  state = { ...state, projects: [row] };
  globalThis.location.pathname = '/p/ffffffffffffffff/';
  expect(await picker.ensureProject()).toBe(true);
  expect(picker.workbenchStatus().projectUsable).toBe(false);
  expect(globalThis.location.pathname).toBe('/p/ffffffffffffffff/');
  globalThis.location.pathname = '/';
});

test('无效项目地址保留 shell，不请求或回落到其它项目', async () => {
  const before = requests.length;
  globalThis.location.pathname = '/p/invalid/';
  expect(await picker.ensureProject()).toBe(true);
  expect(picker.workbenchStatus()).toMatchObject({ project: null, projectUsable: false });
  expect(requests.slice(before)).toEqual([]);
  globalThis.location.pathname = '/';
});
