import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { repo } from '../helpers.js';
import { fetch as localFetch, setup } from './harness.js';

const f = await setup();
await repo(f.root);
const dom = installDom({ fetch: (url, options) => localFetch(f.url + url, options) });
const { boot } = await import('../../src/ui/web/assets/app.js');
afterAll(async () => { dom.restore(); await f.close(); });

test('原 Studio 页面在核心 API 下可加载、发送 say 并打开 AP 详情', async () => {
  await boot();
  expect(dom.node('connection').textContent).toBe('已连接');
  expect(deepText(dom.node('detail'))).toContain('项目概览');
  expect(dom.node('side-nav').querySelectorAll('.nav-item')).toHaveLength(2);
  dom.node('input').value = '从原界面发送目标';
  await dom.node('input-form').onsubmit({ preventDefault() {} });
  const overview = await (await localFetch(f.url + '/api/overview')).json();
  const ap = overview.aps.find(row => row.goal === '从原界面发送目标');
  expect(ap?.ap_kind ?? dom.node('error').textContent).toBe('say');
  const { detail } = await import('../../src/ui/web/assets/navigate.js');
  await detail(ap.id);
  expect(deepText(dom.node('detail'))).toContain('从原界面发送目标');
  expect(deepText(dom.node('detail'))).not.toContain('预约展示');
  await dom.node('ap-graph-open').onclick();
  expect(deepText(dom.node('detail'))).toContain('AP 图');
  expect(deepText(dom.node('detail'))).not.toContain('编排合并全部');
  await dom.node('graph-open').onclick();
  expect(deepText(dom.node('detail'))).toContain('分支与合并');
  expect(deepText(dom.node('detail'))).not.toContain('一键合并全部');
  await dom.node('settings-open').onclick();
  expect(deepText(dom.node('detail'))).toContain('设置');
  expect(deepText(dom.node('detail'))).not.toContain('托管模式');
  expect(dom.node('connection').textContent).toBe('已连接');
});
