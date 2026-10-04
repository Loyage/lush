import { test, expect, afterAll } from 'bun:test';
import { installDom } from '../dom-stub.js';

// 前端项目身份：地址是唯一来源（`/p/<id>/`），项目相关偏好按项目隔离，外观偏好共享。
const dom = installDom({ fetch: async () => new Response('{}') });
afterAll(() => dom.restore());

const { environmentRoute, projectBase, projectApi, projectHref, projectRoute, routeContext } = await import('../../src/ui/web/assets/route.js');
const prefs = await import('../../src/ui/web/assets/prefs.js');
const ID = 'a1b2c3d4e5f60718';
const ENV = 'b'.repeat(32);

test('项目身份来自地址：项目 API 加前缀，宿主级资源不加', () => {
  globalThis.location.pathname = '/';
  expect(projectRoute()).toBeNull();
  expect(projectBase()).toBe('');
  expect(projectApi('/api/snapshot')).toBe('/api/snapshot');
  expect(projectApi('/app.js')).toBe('/app.js');

  globalThis.location.pathname = `/p/${ID}/`;
  expect(projectRoute()).toBe(ID);
  expect(projectBase()).toBe(`/p/${ID}`);
  expect(projectApi('/api/worker/1')).toBe(`/p/${ID}/api/worker/1`);
  // 启动器与随代码发布的文档属于宿主，不挂到任何项目下。
  expect(projectApi('/api/host/projects')).toBe('/api/host/projects');
  expect(projectApi('/api/docs')).toBe('/api/docs');
  expect(projectApi('/app.js')).toBe('/app.js');
  expect(projectHref(ID, '/#worker-1')).toBe(`/p/${ID}/#worker-1`);
  // 环境 + 项目身份同时进入路径；Host API 按环境路由，环境管理 / 文档仍属于入口 Host。
  globalThis.location.pathname = `/e/${ENV}/p/${ID}/`;
  expect(routeContext()).toEqual({ environment: ENV, project: ID, remote: true });
  expect(environmentRoute()).toBe(ENV);
  expect(projectBase()).toBe(`/e/${ENV}/p/${ID}`);
  expect(projectApi('/api/worker/1')).toBe(`/e/${ENV}/p/${ID}/api/worker/1`);
  expect(projectApi('/api/host/projects')).toBe(`/e/${ENV}/api/host/projects`);
  expect(projectApi('/api/environments')).toBe('/api/environments');
  expect(projectHref(ID)).toBe(`/e/${ENV}/p/${ID}/`);
  globalThis.location.pathname = `/e/${ENV}/`;
  expect(projectApi('/api/worker/1')).toBe(`/e/${ENV}/api/worker/1`);
  expect(projectApi('/api/host')).toBe(`/e/${ENV}/api/host`);
  // 非项目路径（ID 后续还有别的字符）不会被误认成项目页。
  globalThis.location.pathname = `/p/${ID}x/`;
  expect(projectRoute()).toBeNull();
  expect(() => projectApi('/api/worker/1')).toThrow('未回落');
  globalThis.location.pathname = '/e/not-an-environment/p/ffffffffffffffff/';
  expect(projectApi('/api/host')).toBe('/e/not-an-environment/api/host');
  globalThis.location.pathname = '/e/invalid%2Fsegment/p/ffffffffffffffff/';
  expect(() => projectApi('/api/host')).toThrow('未回落');
  expect(() => projectHref('../../../../')).toThrow('项目身份');
  expect(projectApi('/api/environments')).toBe('/api/environments');
});

test('项目相关偏好按项目隔离，全局外观偏好共享', () => {
  globalThis.location.pathname = '/';
  prefs.setPref('sidebarSort', 'id');
  prefs.setPref('collapsed', new Set(['tasks']));
  prefs.setPref('theme', 'dark');
  expect(globalThis.localStorage.getItem('lush.sidebarSort')).toBe('id');
  expect(globalThis.localStorage.getItem('lush.theme')).toBe('dark');

  // 另一个项目看不到上一个项目的筛选 / 折叠 / 排序，但共享主题。
  globalThis.location.pathname = `/p/${ID}/`;
  expect(prefs.readPref('sidebarSort')).toBe('smart');
  expect([...prefs.readPref('collapsed')]).toEqual([]);
  expect(prefs.readPref('theme')).toBe('dark');
  prefs.setPref('sidebarSort', 'updated');
  expect(globalThis.localStorage.getItem(`lush.sidebarSort:${ID}`)).toBe('updated');
  expect(globalThis.localStorage.getItem('lush.sidebarSort')).toBe('id');

  // 远端偏好同时包含环境与项目；相同 pid 不会与本地或另一个环境串写。
  globalThis.location.pathname = `/e/${ENV}/p/${ID}/`;
  expect(prefs.readPref('sidebarSort')).toBe('smart');
  prefs.setPref('sidebarSort', 'id');
  expect(globalThis.localStorage.getItem(`lush.sidebarSort:e:${ENV}:p:${ID}`)).toBe('id');
  globalThis.location.pathname = `/p/${ID}/`;
  expect(prefs.readPref('sidebarSort')).toBe('updated');

  // Task 图的状态筛选同样按项目隔离。
  prefs.setPref('taskGraphStatuses', new Set(['completed']));
  globalThis.location.pathname = '/';
  expect(prefs.readPref('taskGraphStatuses').size).toBe(0);
});
