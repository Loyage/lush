import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { repo } from '../helpers.js';
import { fetch as localFetch, setup } from './harness.js';

const f = await setup();
await repo(f.root);
// Exercise the assembled temporary project and production Host services, without mock wire contracts.
const dom = installDom({ fetch: (url, options) => localFetch(f.url + url, options) });
const host = await (await localFetch(f.url + '/api/host')).json();
dom.location.pathname = `/p/${host.projects[0].id}/`;
const { boot } = await import('../../src/ui/web/assets/app.js');
afterAll(async () => { dom.restore(); await f.close(); });

test('固定项目工作页在核心 API 下可加载、发送指令并打开 Worker，设置另开根标签', async () => {
  await boot();
  expect(dom.node('connection').textContent).toBe('已连接');
  expect(deepText(dom.node('detail'))).toContain('项目概览');
  expect(deepText(dom.node('detail'))).toContain('WORKER / 目标与交付');
  expect(deepText(dom.node('detail'))).not.toContain('TASK /');
  expect(dom.node('side-nav').querySelectorAll('.nav-item')).toHaveLength(2);
  dom.node('input').value = '从原界面发送目标';
  await dom.node('input-form').onsubmit({ preventDefault() {} });
  const overview = await (await localFetch(f.url + '/api/overview')).json();
  const task = overview.tasks.find(row => row.goal === '从原界面发送目标');
  expect(task?.task_kind ?? dom.node('error').textContent).toBe('order');
  const { detail } = await import('../../src/ui/web/assets/navigate.js');
  await detail(task.id);
  expect(deepText(dom.node('detail'))).toContain('从原界面发送目标');
  await dom.node('task-graph-open').onclick();
  expect(deepText(dom.node('detail'))).toContain('Worker 树');
  expect(deepText(dom.node('detail'))).not.toContain('Task 图');
  expect(dom.node('view-title').textContent).toBe('Worker 树');
  expect(document.title).toBe(`${f.config.project.split('/').filter(Boolean).at(-1)} · Lush`);
  const details = dom.node('detail').querySelector('[data-graph-focus="detail-mode"]');
  expect(details.checked).toBe(false);
  expect(dom.node('detail').querySelector('.task-graph-minimal')).toBeTruthy();
  details.checked = true; await details.onchange();
  // 首屏只保证结构可读；诊断断言显式等待同一个后台补齐请求，避免把独立 HTTP 读完成当作 UI 已更新。
  const { loadTaskGraph } = await import('../../src/ui/web/assets/render-task-graph.js');
  const graph = await loadTaskGraph();
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
  const view = dom.node('detail').dataset.view; dom.node('input').value = '未发送的后续输入';
  await dom.node('settings-open').onclick();
  expect(dom.node('settings-open').href).toBe('/#settings'); expect(dom.node('settings-open').target).toBe('_blank');
  expect(dom.node('detail').dataset.view).toBe(view); expect(dom.node('input').value).toBe('未发送的后续输入');
  expect(deepText(dom.node('detail'))).toContain('项目概览');
  expect(dom.node('connection').textContent).toBe('已连接');
});
