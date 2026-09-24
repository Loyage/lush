import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { gate, until } from '../helpers.js';
import { makeWorld } from './dom-world.js';
const world = makeWorld();
let pending = null, fail = false;
const directCalls = [];
const dom = installDom({ fetch: async (url, options) => {
  if (String(url) === '/api/action') {
    const body = JSON.parse(options.body);
    if (body.method === 'input.submit') {
      directCalls.push(body);
      if (pending) await pending.promise;
      // 命中快速路由前缀时返回 route 形状（没有 direct/worker 的普通形状），让页面必须按 route 分支处理。
      if (String(body.params.content).startsWith('开发')) {
        return Response.json({ route: { prefix: '开发', target: 'worker' }, worker: { id: 77 }, task: { id: 5 } }, { status: 200 });
      }
      return Response.json(fail ? { error: 'direct failed' } : { worker: { id: 42 }, direct: true }, { status: fail ? 400 : 200 });
    }
  }
  return world.fetchImpl(url, options);
} });
dom.document.createElementNS = (_namespace, tag) => dom.document.createElement(tag);
const { boot } = await import('../../src/ui/web/assets/app.js');
const { syncComposer } = await import('../../src/ui/web/assets/composer.js');
const { renderStatistics } = await import('../../src/ui/web/assets/render-statistics.js');
const { openSettings } = await import('../../src/ui/web/assets/render-settings.js');
await boot();
afterAll(() => dom.restore());

test('direct execution submits only current input, prevents double sends, preserves concurrent typing and drafts', async () => {
  world.state.drafts = [{ id: 11, content: 'keep draft' }];
  await dom.intervalFor(1500)();
  dom.node('input').value = 'small fix'; dom.node('input-branch').value = 'release/next'; syncComposer();
  pending = gate();
  const sent = dom.node('input-direct').onclick();
  await until(() => directCalls.length === 1);
  expect(dom.node('input-direct').disabled).toBe(true);
  expect(dom.node('draft-commit').disabled).toBe(true);
  await dom.node('input-direct').onclick();
  await dom.node('input-form').onsubmit({ preventDefault() {} });
  dom.node('input').value = 'new thought';
  pending.resolve(); await sent; pending = null;
  expect(directCalls).toEqual([{ method: 'input.submit', params: { content: 'small fix', branch: 'release/next', references: [], direct: true } }]);
  expect(dom.node('input').value).toBe('new thought');
  expect(world.state.drafts).toHaveLength(1); expect(world.state.commits).toHaveLength(0);
  expect(dom.node('error').textContent).toContain('未调用规划模型');
  fail = true;
  await dom.node('input-direct').onclick();
  expect(dom.node('input').value).toBe('new thought'); expect(dom.node('input-direct').disabled).toBe(false);
  expect(dom.node('error').textContent).toContain('direct failed'); fail = false;
});

test('direct execution surfaces a route hit instead of assuming a worker shape', async () => {
  dom.node('input').value = '开发 做一个登录页';
  await dom.node('input-direct').onclick();
  expect(dom.node('error').textContent).toContain('前缀 开发 命中，已创建 worker #77');
  expect(dom.node('input').value).toBe('');
});

test('statistics shows bounded attribution and unknown groups without rendering injected HTML', () => {
  const totals = { requests: 1, input: 10, output: 20, cache_read: 30, cache_write: 0, tokens: 60, cost: 0.1, unknown_cost: 0, unknown_tokens: 0 };
  const node = renderStatistics({ totals, range: { start: null, end: '2026-01-01' }, generated_at: '', interval: 'day', buckets: [], models: [], coverage: {},
    roles: [{ role: 'worker', ...totals }], tasks: [{ task_id: 1, role: 'worker', status: 'failed', goal: '<script>x</script>', ...totals }],
    invocations: [{ task_id: 1, role: 'worker', run_id: null, ...totals }],
    attribution: { limit: 100, tasks_truncated: true, unknown_role_requests: 1, unknown_run_requests: 1 } });
  expect(deepText(node)).toContain('按 invocation 归因');
  expect(deepText(node)).toContain('run 未知'); expect(deepText(node)).toContain('最高的 100 组');
  expect(node.querySelector('script')).toBe(null);
});

test('settings saves optional Pi soft budgets and preserves blank as disabled', async () => {
  await openSettings();
  const profile = dom.node('detail').querySelector('[data-agent-target="default"]');
  const responses = profile.querySelector('[data-agent-field="budget_responses"]');
  const tokens = profile.querySelector('[data-agent-field="budget_tokens"]');
  expect(responses.value).toBe('');
  responses.value = '30'; tokens.value = '200000';
  await findByText(profile, '保存配置').onclick();
  expect(world.state.agentConfig.default.soft_budget).toEqual({ responses: 30, tokens: 200000 });
});
