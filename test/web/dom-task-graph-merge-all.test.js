import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText, answerDialog } from './project-dom.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld();
world.state.devicePreferences.values.taskGraphMinimal = false;
const graph = { nodes: [
  { id: 1, parent_id: null, task_kind: 'main', status: 'waiting', title: 'main', branch: 'main' },
  { id: 2, parent_id: 1, task_kind: 'order', status: 'waiting', title: '实现功能', branch: 'lush/task-2',
    workspace: '/tmp/task-2', target_branch: 'main', integration: 'pending', merge_readiness: { ready: true } },
], total: 2, truncated: false };
const reads = [];
const dom = installDom({ fetch: (url, options) => {
  if (!options?.method || options.method === 'GET') reads.push(String(url));
  if (String(url).split('?')[0] === '/api/worker-graph') return Response.json(graph);
  return world.fetchImpl(url, options);
} });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { refresh } = await import('../../src/ui/web/assets/refresh.js');
const { setPref } = await import('../../src/ui/web/assets/prefs.js');
setPref('taskGraphMinimal', false);
await boot();
afterAll(() => dom.restore());

test('current navigation and snapshot refresh have no delivery entry, count or background graph request', async () => {
  expect(dom.node('sidebar').querySelector('#deliveries-open')).toBeNull();
  expect(dom.node('sidebar').querySelector('#delivery-count')).toBeNull();
  await refresh();
  expect(reads.some(url => url.includes('worker-delivery-graph'))).toBe(false);
});

test('tree removes batch merge and tracking while keeping single merge and true parent edges', async () => {
  const before = JSON.stringify(graph);
  await dom.node('task-graph-open').onclick();
  const root = dom.node('detail');
  expect(root.querySelector('.task-graph-merge-all')).toBeNull();
  expect(deepText(root)).not.toContain('合并所有');
  expect(root.querySelectorAll('a').some(link => link.href.includes('#deliveries'))).toBe(false);
  expect(deepText(root)).not.toContain('交付追踪');
  const source = root.querySelector('[data-task-id="2"]');
  const merge = source.querySelectorAll('button').find(node => node.textContent === '合并');
  expect(merge).toBeTruthy(); expect(merge.classList.contains('agent-call')).toBe(true);
  const pending = merge.onclick(); await answerDialog(dom, '合并'); await pending;
  expect(world.state.actions.at(-1)).toEqual({ method: 'worker.reserve', params: { id: 2, kind: 'merge' } });
  expect(world.state.actions.some(row => row.method === 'worker.reserve_all')).toBe(false);
  expect(JSON.stringify(graph)).toBe(before);
});
