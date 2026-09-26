import { test, expect, afterAll } from 'bun:test';
import { installDom } from '../dom-stub.js';

// 全局工作台前端：根路径只按 last_project_id 决定新窗口首次落点；项目页身份来自地址。
let state = { mode: 'launcher', project: null, last_project: null, last_project_id: null, projects: [] };
const requests = [];
const dom = installDom({ fetch: async url => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '');
  requests.push(path);
  if (path.startsWith('/api/launcher/projects')) return Response.json({ projects: state.projects });
  if (path.startsWith('/api/launcher')) return Response.json(state);
  return Response.json({ error: 'not mocked' }, 404);
} });
afterAll(() => dom.restore());

const { ensureProject } = await import('../../src/ui/web/assets/project-picker.js');
const ID = 'a1b2c3d4e5f60718';
const row = { id: ID, project: '/tmp/demo', name: 'demo', connected: false, last: true, error: null };

test('根路径按 last_project_id 跳一次，且不因此启动任何项目 daemon', async () => {
  state = { mode: 'launcher', project: null, last_project: '/tmp/demo', last_project_id: ID, projects: [row] };
  globalThis.location.pathname = '/';
  globalThis.location.hash = '#task-3';
  let replaced = null;
  globalThis.location.replace = url => { replaced = url; };
  try {
    expect(await ensureProject()).toBe(false);
    expect(replaced).toBe(`/p/${ID}/#task-3`);
    // 只读了启动器状态与项目列表；没有对任何项目发 snapshot / action。
    expect(requests.every(path => path.startsWith('/api/launcher'))).toBe(true);
  } finally { delete globalThis.location.replace; }
});

test('没有上次项目时展示项目列表，不启动项目轮询', async () => {
  state = { mode: 'launcher', project: null, last_project: null, last_project_id: null, projects: [row] };
  globalThis.location.pathname = '/';
  expect(await ensureProject()).toBe(false);
  expect(dom.node('project-gate').hidden).toBe(false);
  expect(dom.node('project-list-panel').hidden).toBe(false);
  await Bun.sleep(0);
  expect(dom.node('project-recent-list').children.length).toBe(1);
});

test('已从列表移除的项目页给出明确错误并回到列表，不静默绑定别的项目', async () => {
  state = { mode: 'launcher', project: null, last_project: null, last_project_id: null, projects: [row] };
  globalThis.location.pathname = '/p/ffffffffffffffff/';
  try {
    expect(await ensureProject()).toBe(false);
    expect(dom.node('project-gate').hidden).toBe(false);
    expect(dom.node('project-error').textContent).toContain('已从列表移除');
  } finally { globalThis.location.pathname = '/'; }
});
