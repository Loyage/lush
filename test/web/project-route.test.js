import { test, expect, afterAll } from 'bun:test';
import { installDom } from '../dom-stub.js';

// 地址是唯一项目来源；设备偏好共享，具体工作状态按项目隔离。
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

test('设备排序和图显示偏好共享，折叠/过滤工作状态仍按项目隔离', () => {
  globalThis.location.pathname = '/';
  prefs.setPref('sidebarSort', 'id'); prefs.setPref('taskGraphMinimal', false);
  prefs.setPref('collapsed', new Set(['tasks'])); prefs.setPref('theme', 'dark');
  localStorage.setItem(`lush.sidebarSort:${ID}`, 'updated');
  globalThis.location.pathname = `/p/${ID}/`;
  expect(prefs.readPref('sidebarSort')).toBe('id'); expect(prefs.readPref('taskGraphMinimal')).toBe(false);
  expect([...prefs.readPref('collapsed')]).toEqual([]); expect(prefs.readPref('theme')).toBe('dark');
  prefs.setPref('collapsed', new Set(['notices'])); prefs.setPref('sidebarSort', 'updated');
  prefs.setPref('taskGraphStatuses', new Set(['completed']));
  globalThis.location.pathname = '/p/2222222222222222/';
  expect(prefs.readPref('sidebarSort')).toBe('updated'); expect([...prefs.readPref('collapsed')]).toEqual([]);
  expect(prefs.readPref('taskGraphStatuses').size).toBe(0);
  globalThis.location.pathname = `/p/${ID}/`;
  expect([...prefs.readPref('collapsed')]).toEqual(['notices']); expect([...prefs.readPref('taskGraphStatuses')]).toEqual(['completed']);
  expect(localStorage.getItem(`lush.sidebarSort:${ID}`)).toBe('updated'); // dormant historical key, never read or removed
});
