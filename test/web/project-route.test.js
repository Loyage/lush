import { test, expect, afterAll } from 'bun:test';
import { installDom } from '../dom-stub.js';

// 前端项目身份：地址是唯一来源（`/p/<id>/`），项目相关偏好按项目隔离，外观偏好共享。
const dom = installDom({ fetch: async () => new Response('{}') });
afterAll(() => dom.restore());

const { projectBase, projectApi, projectHref, projectRoute, routeContext } = await import('../../src/ui/web/assets/route.js');
const prefs = await import('../../src/ui/web/assets/prefs.js');
const ID = 'a1b2c3d4e5f60718';

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
  expect(routeContext()).toEqual({ project: ID, invalid: false });
  // 非项目路径（ID 后续还有别的字符）不会被误认成项目页。
  globalThis.location.pathname = `/p/${ID}x/`;
  expect(projectRoute()).toBeNull();
  expect(() => projectApi('/api/worker/1')).toThrow('未回落');
  globalThis.location.pathname = '/p/invalid%2Fsegment/';
  expect(() => projectApi('/api/host')).toThrow('未回落');
  expect(() => projectHref('../../../../')).toThrow('项目身份');
  expect(projectApi('/api/docs')).toBe('/api/docs');
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

  // 不同项目 ID 的视图独立；恢复当前项目不清除别的项目。
  globalThis.location.pathname = '/p/2222222222222222/';
  expect(prefs.readPref('sidebarSort')).toBe('smart');
  prefs.setPref('sidebarSort', 'id');
  globalThis.location.pathname = `/p/${ID}/`;
  expect(prefs.readPref('sidebarSort')).toBe('updated');
  prefs.resetPrefs();
  expect(prefs.readPref('sidebarSort')).toBe('smart');
  expect(globalThis.localStorage.getItem('lush.sidebarSort:2222222222222222')).toBe('id');

  // Task 图的状态筛选同样按项目隔离。
  prefs.setPref('taskGraphStatuses', new Set(['completed']));
  globalThis.location.pathname = '/';
  expect(prefs.readPref('taskGraphStatuses').size).toBe(0);
});
