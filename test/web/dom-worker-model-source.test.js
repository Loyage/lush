import { test, expect, afterAll } from 'bun:test';
import { installDom, dialogButton, deepText, findByText } from '../dom-stub.js';
import { until } from '../helpers.js';

const first = '44444444-4444-4444-8444-444444444444';
const second = '55555555-5555-4555-8555-555555555555';
const connections = [first, second].map((id, i) => ({ id, label: `API ${i}`, provider: 'openai-compatible', endpoint: 'https://models.example/v1',
  enabled: true, auth_type: 'api_key', models: [`model-${i}`], credential: { status: 'configured' } }));
const response = value => ({ ok: true, status: 200, json: async () => value });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const requests = [], actions = [];
let listResponse = null, saving = null;
const dom = installDom({ fetch: async (url, options = {}) => {
  requests.push(String(url));
  if (url === '/api/agent/connections') return listResponse || response({ version: 1, connections });
  if (url === '/api/action') { actions.push(JSON.parse(options.body)); return saving ? saving() : response({ model_selection: { agent: 'pi', connection_id: second, model: 'openai-compatible/model-1', explicit: true } }); }
  throw new Error(`unexpected API ${url}`);
} });
const { ui } = await import('../../src/ui/web/assets/state.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const restore = registerNavigation({ refresh: async () => {} });
const { configureModelSource, canConfigureModelSource, modelSourceControl, modelSourceSummary,
  clearOverrideControl, canClearOverride } = await import('../../src/ui/web/assets/worker-model-source.js');
const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
afterAll(() => { restore(); dom.restore(); });
const task = (extra = {}) => ({ id: 51, task_kind: 'order', status: 'paused', role: 'agent', model_selection: {
  agent: 'pi', connection_id: first, model: 'openai-compatible/model-0', thinking: 'medium', explicit: false,
}, ...extra });
const ready = async () => { await until(() => dialogButton(dom, '保存来源与模型')); await Promise.resolve(); };
const setModel = () => {
  const picker = dom.node('modal').querySelector('[data-worker-model-field="connection_id"]'); picker.value = second; picker.onchange();
  const choice = dom.node('modal').querySelector('[data-connection-model="choice"]'); choice.value = 'openai-compatible/model-1'; choice.onchange();
};

for (const explicit of [false, true]) test(`轻量保存只提交窄选择，不读取或重建完整覆盖 explicit=${explicit}`, async () => {
  requests.length = 0; actions.length = 0;
  const worker = task(); worker.model_selection.explicit = explicit;
  worker.retry_profile = { env: { SECRET: 'do-not-send' }, append_prompt: 'keep', default_prompt: 'keep system', extensions: ['/extension'], skills: ['/skill'], soft_budget: { tokens: 123 } };
  const before = JSON.stringify(worker.retry_profile);
  const pending = configureModelSource(worker); await ready(); setModel();
  expect(dialogButton(dom, '保存来源与模型').classList.contains('agent-call')).toBe(false);
  expect(deepText(dom.node('modal'))).toContain('不改变仍在运行的调用');
  await dialogButton(dom, '保存来源与模型').onclick(); expect(await pending).toBe(true);
  expect(actions).toEqual([{ method: 'worker.configure', params: { id: 51, model_selection: { connection_id: second, model: 'openai-compatible/model-1' } } }]);
  // 选择新来源会额外读取该来源的本地模型目录缓存；这不是额度查询，也不改变保存的窄选择。
  expect(requests.filter(url => !String(url).startsWith('/api/agent/connections/models'))).toEqual(['/api/agent/connections', '/api/action']);
  expect(requests).toContain(`/api/agent/connections/models?id=${second}`);
  expect(JSON.stringify(worker.retry_profile)).toBe(before); expect(worker.model_selection.explicit).toBe(true);
});

test('模型越界和未绑定来源拒绝保存，保留输入可修正', async () => {
  actions.length = 0;
  const pending = configureModelSource(task()); await ready();
  const model = dom.node('modal').querySelector('[data-worker-model-field="model"]'); model.value = 'openai-compatible/outside';
  await dialogButton(dom, '保存来源与模型').onclick(); await ready();
  expect(actions).toHaveLength(0); expect(deepText(dom.node('modal'))).toContain('模型范围'); expect(model.value).toContain('outside');
  const connection = dom.node('modal').querySelector('[data-worker-model-field="connection_id"]'); connection.value = ''; connection.onchange();
  await dialogButton(dom, '保存来源与模型').onclick(); await ready();
  expect(deepText(dom.node('modal'))).toContain('不会回退到外部 Pi'); expect(actions).toHaveLength(0);
  await dialogButton(dom, '取消').onclick(); expect(await pending).toBe(false);
});

test('保存失败保留同一表单并可重试，不启动或继续 Worker', async () => {
  actions.length = 0; saving = () => Promise.reject(new Error('only paused workers can adjust run settings'));
  const pending = configureModelSource(task({ status: 'running', interrupt_state: 'requested' })); await ready(); setModel();
  const model = dom.node('modal').querySelector('[data-worker-model-field="model"]');
  await dialogButton(dom, '保存来源与模型').onclick(); await until(() => deepText(dom.node('modal')).includes('保存失败'));
  expect(dom.node('modal').querySelector('[data-worker-model-field="model"]')).toBe(model); expect(model.value).toBe('openai-compatible/model-1');
  saving = null; await dialogButton(dom, '保存来源与模型').onclick(); expect(await pending).toBe(true);
  expect(actions.map(row => row.method)).toEqual(['worker.configure', 'worker.configure']);
});

test('取消后来源读取迟到不复活弹窗，离页后保存迟到不修改摘要', async () => {
  actions.length = 0; const list = deferred(); listResponse = list.promise;
  const cancelled = configureModelSource(task()); await ready(); await dialogButton(dom, '取消').onclick(); expect(await cancelled).toBe(false);
  list.resolve(response({ version: 1, connections })); await list.promise; await Promise.resolve();
  expect(dom.node('modal').children).toHaveLength(0); expect(actions).toHaveLength(0); listResponse = null;
  const worker = task(), original = worker.model_selection, save = deferred(); saving = () => save.promise;
  const pending = configureModelSource(worker); await ready(); setModel(); await dialogButton(dom, '保存来源与模型').onclick();
  ui.view = { id: 'settings', key: 'new-view' }; save.resolve(response({ model_selection: { ...original, connection_id: second } }));
  expect(await pending).toBe(false); expect(worker.model_selection).toBe(original); saving = null;
});

test('遵守安全准入且对 Codex/旧后台解释禁用原因', async () => {
  actions.length = 0; requests.length = 0;
  for (const state of [{ status: 'running' }, { status: 'queued' }, { status: 'failed' }, { status: 'paused', task_kind: 'analysis' }, { status: 'queued', interrupt_state: 'resuming' }]) {
    expect(canConfigureModelSource(task(state))).toBe(false); expect(modelSourceControl(task(state))).toBeNull();
    expect(await configureModelSource(task(state))).toBe(false);
  }
  const codex = task({ model_selection: { agent: 'codex', model: 'gpt-test', explicit: false } });
  const control = modelSourceControl(codex); expect(control.querySelector('button').disabled).toBe(true); expect(control.getAttribute('data-help')).toContain('Codex CLI');
  expect(await configureModelSource(codex)).toBe(false);
  const old = modelSourceControl(task({ model_selection: null })); expect(old.getAttribute('data-help')).toContain('安全模型选择摘要');
  expect(actions).toHaveLength(0); expect(requests).toHaveLength(0);
});

test('详情提供独立来源入口和后续配置摘要，完整运行设置仍保留', () => {
  const worker = task({ goal: '检查模型来源', integration: 'none', layer: 'work', deps: [], children: [], messages: [], notices: [], calls: 0 });
  renderDetail(worker, [], null, null);
  const panel = dom.node('detail'), source = findByText(panel, '切换模型来源');
  expect(source).not.toBeNull(); expect(source.classList.contains('agent-call')).toBe(false);
  expect(source.getAttribute('data-help')).toContain('保留其他运行覆盖');
  expect(findByText(panel, '调整运行设置')).not.toBeNull();
  expect(deepText(panel)).toContain('下一次配置：pi');
  renderDetail({ ...worker, status: 'running' }, [], null, null);
  expect(findByText(panel, '切换模型来源')).toBeNull();
});

test('已合并 Worker 可显式清除运行覆盖，入口不调用 Agent 且对活跃/终态隐藏', async () => {
  actions.length = 0;
  const explicit = () => ({ agent: 'pi', connection_id: first, model: 'openai-compatible/model-0', thinking: 'medium', explicit: true });
  const worker = task({ status: 'awaiting_acceptance', model_selection: explicit() });
  const control = clearOverrideControl(worker);
  expect(control).not.toBeNull();
  expect(control.classList.contains('agent-call')).toBe(false);
  expect(control.getAttribute('data-help')).toContain('回到项目/角色默认');
  const pending = control.onclick();
  await until(() => dialogButton(dom, '清除覆盖'));
  expect(deepText(dom.node('modal'))).toContain('只有你显式清除或重新保存覆盖才会改变它');
  await dialogButton(dom, '清除覆盖').onclick();
  await pending;
  expect(actions).toEqual([{ method: 'worker.clear_override', params: { id: 51 } }]);
  expect(canClearOverride(task({ status: 'awaiting_acceptance' }))).toBe(false);
  expect(clearOverrideControl(task({ status: 'awaiting_acceptance' }))).toBeNull();
  expect(canClearOverride(task({ status: 'running', model_selection: explicit(), agent: { active: true } }))).toBe(false);
  expect(canClearOverride(task({ status: 'completed', model_selection: explicit() }))).toBe(false);
});

test('运行时来源字段优先于历史，显式null不从旧事件猜测绑定', () => {
  const event = { task_id: 51, type: 'invocation.connection', data: JSON.stringify({ run_id: 9, connection_id: first }) };
  const worker = task({ agent: { active: true, connection_id: second, model: 'actual-model' }, runs: [{ id: 9, status: 'running' }] });
  expect(deepText(modelSourceSummary(worker, [event]))).toContain(`当前调用来源：${second} · actual-model`);
  worker.agent.connection_id = null;
  expect(deepText(modelSourceSummary(worker, [event]))).toContain('当前调用来源：未知');
  worker.agent.active = false; worker.agent.connection_id = second;
  expect(deepText(modelSourceSummary(worker, [event]))).toContain('当前调用来源：无进行中的调用');
});

test('当前来源只取当前运行的绑定事件，不从下次选择或旧事件猜测', () => {
  const worker = task({ agent: { active: true }, runs: [{ id: 9, status: 'running' }] });
  expect(deepText(modelSourceSummary(worker))).toContain('未知（缺少当前调用');
  const old = { task_id: 51, type: 'invocation.connection', data: JSON.stringify({ run_id: 8, connection_id: second }) };
  expect(deepText(modelSourceSummary(worker, [old]))).not.toContain(second);
  const current = { ...old, data: JSON.stringify({ run_id: 9, connection_id: second, model: 'openai-compatible/model-1' }) };
  const summary = deepText(modelSourceSummary(worker, [old, current]));
  expect(summary).toContain(`当前调用来源：${second}`); expect(summary).toContain(`下一次配置：pi → ${first}`); expect(summary).toContain('继承项目 / 角色配置');
});

test('调用来源显示用户命名的连接名称，未加载或已删除时回退连接 ID', () => {
  const worker = task({ agent: { active: true, connection_id: second, model: 'actual-model' } });
  const named = deepText(modelSourceSummary(worker, [], { version: 1, connections }));
  expect(named).toContain('当前调用来源：API 1 · actual-model');
  expect(named).not.toContain(second);
  expect(deepText(modelSourceSummary(task(), [], { version: 1, connections }))).toContain('下一次配置：pi → API 0');
  // 未提供或缺少名称时仍回退到连接 ID，不猜测另一个来源。
  expect(deepText(modelSourceSummary(worker, [], []))).toContain(`当前调用来源：${second} · actual-model`);
});

test('Pi 默认模式摘要说明由执行机器 Pi 决定，不冒称托管来源或模型', () => {
  const piTask = task({ model_selection: { agent: 'pi', config_mode: 'pi', model: '', explicit: true },
    retry_profile: { config_mode: 'pi' } });
  const summary = modelSourceSummary(piTask);
  expect(deepText(summary)).toContain('Pi 默认配置');
  expect(deepText(summary)).toContain('执行机器的 Pi 自行决定来源与模型');
  expect(deepText(summary)).not.toContain(first);
  const lush = modelSourceSummary(task());
  expect(deepText(lush)).toContain(`下一次配置：pi → ${first}`);
});

test('Pi 默认模式禁用窄来源入口，指向完整运行设置且绝不提交 managed model_selection', async () => {
  actions.length = 0; requests.length = 0;
  const piTask = task({ model_selection: { agent: 'pi', config_mode: 'pi', model: '', explicit: true } });
  expect(canConfigureModelSource(piTask)).toBe(true);
  const host = modelSourceControl(piTask);
  expect(host.tagName).toBe('SPAN');
  const control = host.querySelector('button');
  expect(control.disabled).toBe(true);
  expect(host.getAttribute('data-help')).toContain('完整运行设置');
  expect(await configureModelSource(piTask)).toBe(false);
  expect(actions).toHaveLength(0); expect(requests).toHaveLength(0);
  // retry_profile 上的模式同样生效（inspect 摘要缺失时不误开托管入口）。
  const viaProfile = task({ model_selection: { agent: 'pi', model: '', explicit: true }, retry_profile: { config_mode: 'pi' } });
  expect(modelSourceControl(viaProfile).querySelector('button').disabled).toBe(true);
  expect(await configureModelSource(viaProfile)).toBe(false);
  expect(actions).toHaveLength(0);
});

test('Lush 模式窄入口仍只提交连接与模型，不携带 config_mode', async () => {
  actions.length = 0; requests.length = 0;
  const pending = configureModelSource(task()); await ready(); setModel();
  await dialogButton(dom, '保存来源与模型').onclick(); expect(await pending).toBe(true);
  expect(actions).toEqual([{ method: 'worker.configure', params: { id: 51, model_selection: { connection_id: second, model: 'openai-compatible/model-1' } } }]);
  expect(actions[0].params.model_selection).not.toHaveProperty('config_mode');
});
