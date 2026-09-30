import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { repo } from '../helpers.js';
import { fetch as localFetch, setup } from './harness.js';

const f = await setup();
await repo(f.root);
const dom = installDom({ fetch: (url, options) => localFetch(f.url + url, options) });
const { boot } = await import('../../src/ui/web/assets/app.js');
afterAll(async () => { dom.restore(); await f.close(); });

test('原 Studio 页面在核心 API 下可加载、发送 say 并打开 Task 详情', async () => {
  await boot();
  expect(dom.node('connection').textContent).toBe('已连接');
  expect(deepText(dom.node('detail'))).toContain('项目概览');
  expect(dom.node('side-nav').querySelectorAll('.nav-item')).toHaveLength(2);
  dom.node('input').value = '从原界面发送目标';
  await dom.node('input-form').onsubmit({ preventDefault() {} });
  const overview = await (await localFetch(f.url + '/api/overview')).json();
  const task = overview.tasks.find(row => row.goal === '从原界面发送目标');
  expect(task?.task_kind ?? dom.node('error').textContent).toBe('say');
  const { detail } = await import('../../src/ui/web/assets/navigate.js');
  await detail(task.id);
  expect(deepText(dom.node('detail'))).toContain('从原界面发送目标');
  await dom.node('task-graph-open').onclick();
  expect(deepText(dom.node('detail'))).toContain('任务树');
  expect(deepText(dom.node('detail'))).not.toContain('Task 图');
  expect(dom.node('view-title').textContent).toBe('任务树');
  expect(document.title).toBe('Lush · 任务树');
  // 真 RPC → HTTP → Task 卡片，验证合入后的诊断字段，不只依赖 DOM fixture。
  const graph = await (await localFetch(f.url + '/api/task-graph')).json();
  const node = graph.nodes.find(row => row.id === task.id);
  expect(node.branch_info).toMatchObject({ parent: 'main', current: false,
    relation: { status: 'equal', ahead: 0, behind: 0 } });
  const card = dom.node('detail').querySelector(`[data-task-id="${task.id}"]`);
  expect(deepText(card)).toContain('Git 父分支：main');
  expect(deepText(card)).toContain('Git 关系：一致 · 领先 0 / 落后 0 个提交');
  const main = graph.nodes.find(row => row.task_kind === 'main');
  expect(main.branch_info.current).toBe(true);
  expect(deepText(dom.node('detail').querySelector(`[data-task-id="${main.id}"]`))).toContain('当前检出');
  dom.location.hash = '#graph';
  await dom.fire('hashchange');
  expect(deepText(dom.node('detail'))).toContain('项目概览');
  expect(deepText(dom.node('detail'))).not.toContain('分支与合并');
  await dom.node('settings-open').onclick();
  expect(deepText(dom.node('detail'))).toContain('设置');
  expect(deepText(dom.node('detail'))).not.toContain('托管模式');
  expect(dom.node('connection').textContent).toBe('已连接');
});
