import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { gate, until } from '../helpers.js';
import { makeWorld } from './dom-world.js';
const world = makeWorld();
let pending = null, fail = false;
const submitCalls = [];
const dom = installDom({ fetch: async (url, options) => {
  if (String(url) === '/api/action') {
    const body = JSON.parse(options.body);
    if (body.method === 'say.submit') {
      submitCalls.push(body);
      if (pending) await pending.promise;
      if (fail) return Response.json({ error: 'send failed' }, { status: 400 });
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

test('Web 直接发送只发当前正文：防重复、保留并发编辑与其它草稿', async () => {
  world.state.drafts = [{ id: 11, content: 'keep draft', references: [] }];
  await dom.intervalFor(1500)();
  dom.node('input').value = 'small fix'; dom.node('input-branch').value = 'release/next'; syncComposer();
  pending = gate();
  const sent = dom.node('input-form').onsubmit({ preventDefault() {} });
  await until(() => submitCalls.length === 1);
  expect(dom.node('draft-commit').disabled).toBe(true);
  await dom.node('input-form').onsubmit({ preventDefault() {} });
  dom.node('input').value = 'new thought';
  pending.resolve(); await sent; pending = null;
  expect(submitCalls).toHaveLength(1);
  expect(submitCalls[0]).toEqual({ method: 'say.submit', params: { content: 'small fix', references: [], branch: 'release/next' } });
  expect(dom.node('input').value).toBe('new thought');
  expect(world.state.drafts.map(row => row.id)).toEqual([11]);
  expect(dom.node('error').textContent).toContain('其它草稿仍在缓存中');
  fail = true;
  await dom.node('input-form').onsubmit({ preventDefault() {} });
  expect(dom.node('error').textContent).toContain('send failed');
  expect(dom.node('input').value).toBe('new thought');
  expect(world.state.drafts.map(row => row.id)).toEqual([11]);
  fail = false;
});

test('空输入不发送，草稿仍可从单条按钮发送', async () => {
  dom.node('input').value = ''; syncComposer();
  const count = submitCalls.length;
  expect(dom.node('draft-commit').disabled).toBe(true);
  await dom.node('input-form').onsubmit({ preventDefault() {} });
  expect(submitCalls).toHaveLength(count);
  expect(world.state.drafts.map(row => row.id)).toEqual([11]);
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
