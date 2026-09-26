import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from '../helpers.js';
import { fetch } from './harness.js';
import { startWeb } from '../../src/ui/web/server.js';
import { projectRouteId, readLauncherState } from '../../src/ui/launcher.js';

/**
 * S-01 回归：同一全局 Web 下 A、B 两个项目都有同号 Task。
 * 页面 A 的写请求只能落到 A 或被拒；服务端不再有「当前项目」可被别的标签页切换。
 */
function mockHost(calls) {
  const openProject = async project => {
    calls.push([project, 'open']);
    return { config: { project, home: path.join(project, '.lush') }, client: {
      async request(method, params = {}) {
        calls.push([project, method, params]);
        if (method === 'system.summary') return { project, revision: `${project}:1`, agents_total: 2, notices: 1,
          intents: { waiting_approval: 0 }, pending_merges: [], provider: 'mock' };
        return { project, method, ok: true };
      },
      async snapshot() { calls.push([project, 'snapshot']); return { status: { project }, inputs: [], tasks: [] }; },
    } };
  };
  return openProject;
}

function post(url, body, headers = {}) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

test('S-01：项目 A 的写请求不会因别的标签页打开 B 而落到 B', async () => {
  const a = temp(), b = temp(), global = temp();
  const env = { ...process.env, LUSH_GLOBAL_CONFIG: global };
  const calls = [];
  const web = startWeb(null, 0, { env, openProject: mockHost(calls) });
  const url = `http://127.0.0.1:${web.port}`;
  const idA = projectRouteId(fs.realpathSync(a)), idB = projectRouteId(fs.realpathSync(b));
  try {
    expect((await post(url + '/api/launcher/select', { project: a })).status).toBe(200);
    expect((await post(url + '/api/launcher/select', { project: b })).status).toBe(200);

    // A 页面准备的写请求带着 A 的身份：只作用于 A。
    calls.length = 0;
    expect((await post(`${url}/p/${idA}/api/action`, { method: 'task.cancel', params: { id: 1 } })).status).toBe(200);
    expect((await post(`${url}/p/${idA}/api/action`, { method: 'task.approve_merge', params: { id: 1 } })).status).toBe(200);
    expect(calls.filter(([, method]) => method !== 'open')).toEqual([
      [fs.realpathSync(a), 'task.cancel', { id: 1 }],
      [fs.realpathSync(a), 'task.approve_merge', { id: 1 }],
    ]);

    // 项目页与会话页是同一份 shell；全局根页面是项目启动器。
    expect((await fetch(`${url}/p/${idA}/`)).status).toBe(200);
    expect(await (await fetch(`${url}/p/${idA}/`)).text()).toContain('id="project-gate"');
    expect(await (await fetch(`${url}/p/${idA}/`)).text()).toContain('id="project-list-panel"');
    // 宿主级资源与文档不挂项目前缀。
    expect((await fetch(`${url}/app.js`)).status).toBe(200);
    expect((await fetch(`${url}/api/docs`)).status).toBe(200);

    // 旧页面发出的无项目身份写请求被拒绝，绝不回退到「当前项目」。
    calls.length = 0;
    const legacy = await post(url + '/api/action', { method: 'task.cancel', params: { id: 1 } });
    expect(legacy.status).toBe(400);
    expect((await legacy.json()).error).toContain('缺少项目身份');
    expect(calls).toEqual([]);

    // 未知 / 伪造的项目身份同样拒绝。
    expect((await fetch(`${url}/p/${'0'.repeat(16)}/api/snapshot`)).status).toBe(400);
    expect((await fetch(`${url}/p/${'z'.repeat(16)}/api/snapshot`)).status).toBe(400);
    expect((await fetch(`${url}/p/${'0'.repeat(16)}/`)).status).toBe(303);
  } finally {
    web.stop(true);
    for (const dir of [a, b, global]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('每个项目页只读到自己项目的快照与摘要', async () => {
  const a = temp(), b = temp(), global = temp();
  const env = { ...process.env, LUSH_GLOBAL_CONFIG: global };
  const calls = [];
  const web = startWeb(null, 0, { env, openProject: mockHost(calls) });
  const url = `http://127.0.0.1:${web.port}`;
  const idA = projectRouteId(fs.realpathSync(a)), idB = projectRouteId(fs.realpathSync(b));
  try {
    expect((await post(url + '/api/launcher/select', { project: a })).status).toBe(200);
    expect((await post(url + '/api/launcher/select', { project: b })).status).toBe(200);

    expect((await (await fetch(`${url}/p/${idA}/api/snapshot`)).json()).status.project).toBe(fs.realpathSync(a));
    expect((await (await fetch(`${url}/p/${idB}/api/snapshot`)).json()).status.project).toBe(fs.realpathSync(b));
    // 单项目模式遗留的无前缀读路由在全局模式同样拒绝。
    expect((await fetch(url + '/api/snapshot')).status).toBe(400);

    const { projects } = await (await fetch(url + '/api/launcher/projects')).json();
    expect(projects.map(row => row.id).sort()).toEqual([idA, idB].sort());
    expect(projects.every(row => row.connected && row.summary?.revision)).toBe(true);
    expect(projects.find(row => row.id === idA).summary).toMatchObject({ notices: 1, agents_total: 2 });
  } finally {
    web.stop(true);
    for (const dir of [a, b, global]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('从列表移除只删入口并断开 Web 连接，不停止 daemon（不关闭连接对象）', async () => {
  const a = temp(), global = temp();
  const env = { ...process.env, LUSH_GLOBAL_CONFIG: global };
  const calls = [];
  const web = startWeb(null, 0, { env, openProject: mockHost(calls) });
  const url = `http://127.0.0.1:${web.port}`;
  const idA = projectRouteId(fs.realpathSync(a));
  try {
    expect((await post(url + '/api/launcher/select', { project: a })).status).toBe(200);
    expect((await fetch(`${url}/p/${idA}/api/snapshot`)).status).toBe(200);

    const removed = await post(url + '/api/launcher/remove', { id: idA });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ project: fs.realpathSync(a), projects: [] });
    expect(readLauncherState(env)).toMatchObject({ last_project: null, projects: [] });
    // 入口没了，路由身份也随之失效；不会静默绑定到别的目录。
    expect((await fetch(`${url}/p/${idA}/api/snapshot`)).status).toBe(400);
    expect((await fetch(`${url}/p/${idA}/`)).status).toBe(303);
  } finally {
    web.stop(true);
    for (const dir of [a, global]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('canonical 别名不会产生第二个项目身份', async () => {
  const a = temp(), global = temp();
  const env = { ...process.env, LUSH_GLOBAL_CONFIG: global };
  const calls = [];
  const web = startWeb(null, 0, { env, openProject: mockHost(calls) });
  const url = `http://127.0.0.1:${web.port}`;
  const alias = `${global}/alias-for-a`;
  fs.symlinkSync(fs.realpathSync(a), alias);
  const idA = projectRouteId(fs.realpathSync(a));
  try {
    // 用别名登记 → 服务端 canonical 化后只产生一个身份，且就是真实路径的 ID。
    const selected = await (await post(url + '/api/launcher/select', { project: alias })).json();
    expect(selected.id).toBe(idA);
    expect(selected.project).toBe(fs.realpathSync(a));
    expect((await fetch(`${url}/p/${idA}/api/snapshot`)).status).toBe(200);
    expect(projectRouteId(alias)).not.toBe(idA);
    expect((await fetch(`${url}/p/${projectRouteId(alias)}/api/snapshot`)).status).toBe(400);
  } finally {
    web.stop(true);
    fs.rmSync(alias, { force: true });
    for (const dir of [a, global]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('并发打开同一项目只连接一次（single-flight）', async () => {
  const a = temp(), global = temp();
  const env = { ...process.env, LUSH_GLOBAL_CONFIG: global };
  let opens = 0;
  const openProject = async project => {
    opens += 1;
    await Bun.sleep(20);
    return { config: { project, home: path.join(project, '.lush') }, client: { async snapshot() { return { status: { project } }; } } };
  };
  const web = startWeb(null, 0, { env, openProject });
  const url = `http://127.0.0.1:${web.port}`;
  const id = projectRouteId(fs.realpathSync(a));
  try {
    expect((await post(url + '/api/launcher/select', { project: a })).status).toBe(200);
    const statuses = await Promise.all([1, 2, 3, 4].map(() => fetch(`${url}/p/${id}/api/snapshot`).then(response => response.status)));
    expect(statuses).toEqual([200, 200, 200, 200]);
    expect(opens).toBe(1);
  } finally {
    web.stop(true);
    for (const dir of [a, global]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('公网白名单只允许打开登记目录，且不把登记列表当成白名单的替代', async () => {
  const allowed = temp(), denied = temp(), global = temp();
  const env = { ...process.env, LUSH_GLOBAL_CONFIG: global };
  const password = 'launcher password at least twelve';
  fs.writeFileSync(path.join(global, 'web.json'), JSON.stringify({ version: 1, username: 'owner', password, projects: [allowed] }, null, 2) + '\n', { mode: 0o600 });
  // 本机模式曾登记过白名单外的目录：公网模式必须忽略它，而不是把它当成可选项目。
  fs.writeFileSync(path.join(global, 'launcher.json'), JSON.stringify({ version: 2, last_project: denied, projects: [denied, allowed] }), { mode: 0o600 });
  const calls = [];
  const web = startWeb(null, 0, { env, openProject: mockHost(calls) });
  const url = `http://127.0.0.1:${web.port}`;
  try {
    const login = await fetch(url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `username=owner&password=${encodeURIComponent(password)}&next=%2F` });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const headers = { Cookie: cookie };
    const status = await (await fetch(url + '/api/launcher', { headers })).json();
    expect(status.allowed_projects).toEqual([fs.realpathSync(allowed)]);
    expect(status.projects.map(row => row.project)).toEqual([fs.realpathSync(allowed)]);
    expect(status.last_project).toBeNull();
    const deniedId = projectRouteId(fs.realpathSync(denied));
    expect((await fetch(`${url}/p/${deniedId}/api/snapshot`, { headers })).status).toBe(400);
    expect((await fetch(`${url}/p/${deniedId}/`, { headers })).status).toBe(303);
  } finally {
    web.stop(true);
    for (const dir of [allowed, denied, global]) fs.rmSync(dir, { recursive: true, force: true });
  }
});
