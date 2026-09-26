import { test, expect, afterAll } from 'bun:test';
import { installDom } from '../dom-stub.js';

// 前端项目身份：地址是唯一来源（`/p/<id>/`），项目相关偏好按项目隔离，外观偏好共享。
const dom = installDom({ fetch: async () => new Response('{}') });
afterAll(() => dom.restore());

const { projectBase, projectApi, projectHref, projectRoute } = await import('../../src/ui/web/assets/route.js');
const prefs = await import('../../src/ui/web/assets/prefs.js');
const state = await import('../../src/ui/web/assets/state.js');
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
  expect(projectApi('/api/task/1')).toBe(`/p/${ID}/api/task/1`);
  // 启动器与随代码发布的文档属于宿主，不挂到任何项目下。
  expect(projectApi('/api/launcher/projects')).toBe('/api/launcher/projects');
  expect(projectApi('/api/docs')).toBe('/api/docs');
  expect(projectApi('/app.js')).toBe('/app.js');
  expect(projectHref(ID, '/#task-1')).toBe(`/p/${ID}/#task-1`);
  // 非项目路径（ID 后续还有别的字符）不会被误认成项目页。
  globalThis.location.pathname = `/p/${ID}x/`;
  expect(projectRoute()).toBeNull();
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

  // 分支图折叠同样按项目隔离。
  expect(state.readGraphCollapsedPref().size).toBe(0);
  globalThis.location.pathname = '/';
  expect(globalThis.localStorage.getItem('lush.graphCollapsed')).toBeNull();
});
