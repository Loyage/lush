import { test, expect, afterAll } from 'bun:test';
import { installDom, dialogButton, deepText } from '../dom-stub.js';
import { until } from '../helpers.js';

const actions = [];
const dom = installDom({ fetch: async (url, options = {}) => {
  if (url === '/api/action') actions.push(JSON.parse(options.body));
  return { ok: true, status: 200, json: async () => ({}) };
} });
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const restore = registerNavigation({ refresh: async () => {}, detail: async () => {}, overview: async () => {}, graph: async () => {} });
const { modelSourceSummary, clearOverrideControl, canClearOverride } = await import('../../src/ui/web/assets/worker-model-source.js');
const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
afterAll(() => { restore(); dom.restore(); });
const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const task = (extra = {}) => ({ id: 51, role: 'agent', task_kind: 'order', status: 'paused', goal: '运行设置',
  deps: [], dependents: [], children: [], messages: [], notices: [],
  model_selection: { agent: 'pi', connection_id: first, model: 'provider/model', explicit: false }, ...extra });
const find = (panel, text) => [...panel.querySelectorAll('button')].find(node => node.textContent === text);

test('详情只提供一个运行设置入口，来源摘要保留，状态与后端不产生重复按钮', () => {
  const panel = dom.node('detail');
  for (const state of [{}, { task_kind: 'child' }, { status: 'running', interrupt_state: 'requested' },
    { model_selection: { agent: 'codex', explicit: false } },
    { model_selection: { agent: 'pi', config_mode: 'pi', explicit: true } }]) {
    renderDetail(task(state), [], null, null);
    expect(panel.querySelectorAll('button').filter(node => node.textContent === '调整运行设置')).toHaveLength(1);
    expect(find(panel, '切换模型来源')).toBeUndefined();
    expect(find(panel, '调整运行设置').classList.contains('agent-call')).toBe(false);
    expect(find(panel, '调整运行设置').getAttribute('data-help')).toContain('模型来源');
    expect(deepText(panel)).toContain('下一次配置：');
  }
  for (const state of [{ status: 'running' }, { status: 'queued' }, { status: 'failed' }, { status: 'completed' },
    { status: 'running', interrupt_state: 'resuming' }, { task_kind: 'analysis' }]) {
    renderDetail(task(state), [], null, null);
    expect(find(panel, '调整运行设置')).toBeUndefined();
    expect(find(panel, '切换模型来源')).toBeUndefined();
  }
});

test('已合并 Worker 显式清除覆盖不调用 Agent，活跃和终态不可用', async () => {
  actions.length = 0;
  const explicit = { agent: 'pi', connection_id: first, model: 'provider/model', explicit: true };
  const control = clearOverrideControl(task({ status: 'awaiting_acceptance', model_selection: explicit }));
  expect(control.classList.contains('agent-call')).toBe(false);
  expect(control.getAttribute('data-help')).toContain('回到项目/角色默认');
  const pending = control.onclick(); await until(() => dialogButton(dom, '清除覆盖'));
  await dialogButton(dom, '清除覆盖').onclick(); await pending;
  expect(actions).toEqual([{ method: 'worker.clear_override', params: { id: 51 } }]);
  for (const state of [{}, { status: 'running', agent: { active: true }, model_selection: explicit },
    { status: 'completed', model_selection: explicit }]) expect(canClearOverride(task(state))).toBe(false);
});

test('当前绑定与下次配置分开，null 和旧事件不作为当前绑定证据', () => {
  const event = { task_id: 51, type: 'invocation.connection', data: JSON.stringify({ run_id: 9, connection_id: second, model: 'actual-model' }) };
  const worker = task({ agent: { active: true, connection_id: second, model: 'actual-model' }, runs: [{ id: 9, status: 'running' }] });
  expect(deepText(modelSourceSummary(worker, [event]))).toContain(`当前调用来源：${second} · actual-model`);
  worker.agent.connection_id = null;
  expect(deepText(modelSourceSummary(worker, [event]))).toContain('当前调用来源：未知');
  worker.agent.active = false;
  expect(deepText(modelSourceSummary(worker, [event]))).toContain('无进行中的调用');
  worker.agent = { active: true };
  expect(deepText(modelSourceSummary(worker, [{ ...event, data: JSON.stringify({ run_id: 8, connection_id: second }) }]))).not.toContain(second);
  expect(deepText(modelSourceSummary(worker, [event]))).toContain(`当前调用来源：${second}`);
  expect(deepText(modelSourceSummary(worker, [event]))).toContain(`下一次配置：pi → ${first}`);
});

test('来源名称来自连接列表，Pi 默认模式不冒称托管来源', () => {
  const connections = [{ id: first, label: '账号 A' }, { id: second, label: '账号 B' }];
  const worker = task({ agent: { active: true, connection_id: second, model: 'actual-model' } });
  const named = deepText(modelSourceSummary(worker, [], { connections }));
  expect(named).toContain('当前调用来源：账号 B'); expect(named).toContain('下一次配置：pi → 账号 A');
  expect(deepText(modelSourceSummary(worker, [], []))).toContain(second);
  const pi = deepText(modelSourceSummary(task({ model_selection: { agent: 'pi', config_mode: 'pi', explicit: true } })));
  expect(pi).toContain('执行机器的 Pi 自行决定来源与模型'); expect(pi).not.toContain(first);
});
