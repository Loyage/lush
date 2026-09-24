import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { gate, until } from '../helpers.js';
import { makeWorld } from './dom-world.js';
const world = makeWorld();
let pending = null, fail = false;
const commitCalls = [];
const dom = installDom({ fetch: async (url, options) => {
  if (String(url) === '/api/action') {
    const body = JSON.parse(options.body);
    if (body.method === 'draft.commit') {
      const ids = body.params.ids ?? world.state.drafts.map(row => row.id);
      const contents = world.state.drafts.filter(row => ids.includes(row.id)).map(row => row.content);
      commitCalls.push(body);
      if (pending) await pending.promise;
      if (fail) return Response.json({ error: 'commit failed' }, { status: 400 });
      const response = await world.fetchImpl(url, options);
      const data = await response.json();
      // 模拟逐条执行：每条草稿一个 input；命中快速路由前缀时返回 route + 对应 target 字段，
      // 让页面必须按 target 取 worker/research，而不是假定 worker。
      const inputs = contents.map((content, index) => {
        const base = { id: index + 1, content, task: { id: 5 + index }, draft: ids[index] };
        if (content.startsWith('开发')) return { ...base, route: { prefix: '开发', target: 'worker' }, worker: { id: 77 } };
        if (content.startsWith('调研')) return { ...base, route: { prefix: '调研', target: 'research' }, research: { id: 88 } };
        return base;
      });
      return Response.json({ inputs, drafts: data.drafts ?? ids });
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

test('全部执行先暂存正文再逐条提交：防重复、保留并发输入与草稿', async () => {
  world.state.drafts = [{ id: 11, content: 'keep draft', references: [] }];
  await dom.intervalFor(1500)();
  dom.node('input').value = 'small fix'; dom.node('input-branch').value = 'release/next'; syncComposer();
  pending = gate();
  const sent = dom.node('input-form').onsubmit({ preventDefault() {} });
  await until(() => commitCalls.length === 1);
  expect(dom.node('draft-commit').disabled).toBe(true);
  // 提交期间重复提交被忽略
  await dom.node('input-form').onsubmit({ preventDefault() {} });
  // 提交期间继续打字不被覆盖
  dom.node('input').value = 'new thought';
  pending.resolve(); await sent; pending = null;
  expect(commitCalls).toHaveLength(1);
  // 先 buffer 正文，再不带 ids 提交全部未提交草稿
  expect(commitCalls[0]).toEqual({ method: 'draft.commit', params: { branch: 'release/next' } });
  expect(dom.node('input').value).toBe('new thought');
  expect(world.state.drafts).toHaveLength(0);
  expect(dom.node('error').textContent).toContain('已逐条执行 2 条');
  // 失败时草稿保留、错误提示出来
  world.state.drafts = [{ id: 41, content: 'uncommitted', references: [] }];
  dom.node('input').value = '';
  await dom.intervalFor(1500)();
  fail = true;
  await dom.node('input-form').onsubmit({ preventDefault() {} });
  expect(dom.node('error').textContent).toContain('commit failed');
  expect(world.state.drafts.map(row => row.id)).toEqual([41]);
  fail = false;
});

test('全部执行按快速路由结果提示，不假定 worker', async () => {
  world.state.drafts = [
    { id: 51, content: '开发 做一个登录页', references: [] },
    { id: 52, content: '调研 竞品', references: [] },
  ];
  await dom.intervalFor(1500)();
  syncComposer();
  await dom.node('input-form').onsubmit({ preventDefault() {} });
  const text = dom.node('error').textContent;
  expect(text).toContain('已逐条执行 2 条');
  expect(text).toContain('快速路由命中 2 条');
  expect(text).toContain('开发 → worker #77');
  expect(text).toContain('调研 → research #88');
  expect(world.state.drafts).toHaveLength(0);
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
