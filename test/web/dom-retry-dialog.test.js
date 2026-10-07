import { test, expect, afterAll } from 'bun:test';
import { installDom, dialogButton, deepText } from '../dom-stub.js';
import { until } from '../helpers.js';

const actions = [];
const environmentReads = [];
const id = '44444444-4444-4444-8444-444444444444';
const codexId = '55555555-5555-4555-8555-555555555555';
const managedConnections = [{ id, label: '兼容服务', provider: 'openai-compatible', endpoint: 'https://models.example/v1',
  enabled: true, auth_type: 'api_key', models: ['custom-model'], credential: { status: 'configured' } },
  { id: codexId, label: 'Lush Codex OAuth', provider: 'openai-codex', auth_type: 'oauth', enabled: true,
    models: ['gpt-5.4', 'gpt-5.4-mini'], credential: { status: 'configured' } }];
let connectionResponse = null;
const commonEnv = { SHARED: 'common', COMMON: 'only-common' };
const roleEnv = { SHARED: 'role', ROLE: 'only-role' };
const profile = { agent: 'pi', connection_id: codexId, model: 'openai-codex/gpt-5.4', thinking: 'medium', default_prompt: '', append_prompt: '',
  extensions: [], skills: [], soft_budget: {} };
const settings = {
  version: 1, default: profile, roles: {}, resolved: { worker: profile },
  options: {
    agents: ['pi', 'codex'], thinking: { pi: ['', 'low', 'medium', 'high'], codex: ['', 'low', 'high'] },
    models: { pi: ['openai-codex/gpt-5.4', 'openai-codex/gpt-5.4-mini'], codex: ['gpt-5.4-mini'] },
    default_prompts: { worker: '内置 worker Prompt' }, default_prompt: '默认 Prompt',
  },
};
const response = value => ({ ok: true, status: 200, json: async () => value });
const dom = installDom({ fetch: async (url, options = {}) => {
  if (url === '/api/agent/config') return response(settings);
  if (url === '/api/agent/connections') return connectionResponse || response({ version: 1, connections: managedConnections });
  if (url.startsWith('/api/agent/environment?target=')) {
    const target = new URL(url, 'http://localhost').searchParams.get('target');
    environmentReads.push(target);
    return response({ target, values: target === 'common' ? commonEnv : roleEnv });
  }
  if (url.startsWith('/api/agent/models')) return response({ models: [{ id: 'openai-codex/gpt-5.4-mini', label: 'GPT 5.4 mini' }] });
  if (url === '/api/agent/resources') return response({
    extensions: [{ id: '/tmp/review.js', label: 'Review helper', description: '本轮检查工具' }],
    skills: [{ id: '/tmp/ui-skill', label: 'UI skill', description: '界面检查' }],
  });
  if (url === '/api/action') { const body = JSON.parse(options.body); actions.push(body); return response({ status: 'queued' }); }
  return response({});
} });
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const restoreNavigation = registerNavigation({ refresh: async () => {}, detail: async () => {}, overview: async () => {}, graph: async () => {} });
const { retryTask, configureTask } = await import('../../src/ui/web/assets/retry-dialog.js');
const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');

afterAll(() => { restoreNavigation(); dom.restore(); });

test('检查后重试编辑完整 Profile，并只把覆盖参数提交给 worker.retry', async () => {
  const pending = retryTask({ id: 42, role: 'worker', status: 'failed' });
  await until(() => dialogButton(dom, '使用这些设置重试'));
  const modal = dom.node('modal');
  expect(deepText(modal)).toContain('只用于本轮重试');
  expect(deepText(modal)).toContain('默认 Prompt');
  expect(deepText(modal)).toContain('扩展与 Skills');
  expect(environmentReads).toEqual(['common', 'worker']);

  const model = modal.querySelector('[data-retry-field="model"]');
  const thinking = modal.querySelector('[data-retry-field="thinking"]');
  const appendPrompt = modal.querySelector('[data-retry-field="append-prompt"]');
  model.value = 'openai-codex/gpt-5.4-mini'; thinking.value = 'high'; appendPrompt.value = '先复盘错误，再做最小修复';
  const extension = modal.querySelector('[data-retry-resource="extensions"]');
  extension.checked = true; extension.onchange();

  await dialogButton(dom, '读取项目连接').onclick();
  await dialogButton(dom, '使用这些设置重试').onclick();
  expect(await pending).toBe(true);
  expect(actions).toHaveLength(1);
  expect(actions[0]).toEqual({ method: 'worker.retry', params: { id: 42, profile: {
    agent: 'pi', config_mode: 'lush', connection_id: codexId, model: 'openai-codex/gpt-5.4-mini', thinking: 'high', default_prompt: '',
    append_prompt: '先复盘错误，再做最小修复', extensions: ['/tmp/review.js'], skills: [], soft_budget: {}, env: { ...commonEnv, ...roleEnv },
  } } });
});

test('详情页的「检查后重试」打开完整 Profile，可切换模型来源再重试', async () => {
  actions.length = 0;
  const task = { id: 71, role: 'worker', task_kind: 'order', status: 'failed',
    deps: [], dependents: [], children: [], messages: [], notices: [], reservation: null,
    auto_merge: { enabled: false, locked: false, editable: false } };
  renderDetail(task, null, null, null);
  const reopen = [...dom.node('detail').querySelectorAll('button')].find(node => node.textContent === '检查后重试');
  expect(reopen).toBeTruthy();
  const pending = reopen.onclick();
  await until(() => dialogButton(dom, '使用这些设置重试'));
  const modal = dom.node('modal');
  expect(deepText(modal)).toContain('账号连接');
  expect(modal.querySelector('[data-retry-field="connection_id"]')).toBeTruthy();
  await dialogButton(dom, '暂不重试').onclick();
  expect(await pending).toBeUndefined();
  expect(actions).toHaveLength(0);
});

test('暂停中的「调整运行设置」只保存 Profile，不启动 Agent', async () => {
  actions.length = 0;
  const pending = configureTask({ id: 42, role: 'worker', status: 'paused' });
  await until(() => dialogButton(dom, '保存设置'));
  const modal = dom.node('modal');
  expect(deepText(modal)).toContain('下一次 Agent 调用');
  await dialogButton(dom, '读取项目连接').onclick();
  await dialogButton(dom, '保存设置').onclick();
  expect(await pending).toBe(true);
  expect(actions).toHaveLength(1);
  expect(actions[0].method).toBe('worker.configure');
  expect(actions[0].params.id).toBe(42);
  expect(actions[0].params.profile).toMatchObject({ agent: 'pi' });
});

test('请求中断但仍在运行时可以保存设置，不冒充已暂停或热更新旧调用', async () => {
  actions.length = 0;
  const pending = configureTask({ id: 43, role: 'worker', status: 'running', interrupt_state: 'requested' });
  await until(() => dialogButton(dom, '保存设置'));
  const modal = dom.node('modal');
  expect(deepText(modal)).toContain('不改变仍在运行的调用');
  expect(deepText(modal)).not.toContain('Worker 已暂停');
  expect(dialogButton(dom, '保存设置').classList.contains('agent-call')).toBe(false);
  await dialogButton(dom, '读取项目连接').onclick();
  await dialogButton(dom, '保存设置').onclick();
  expect(await pending).toBe(true);
  expect(actions).toHaveLength(1);
  expect(actions[0]).toMatchObject({ method: 'worker.configure', params: { id: 43 } });
});

test('Worker暂停配置和失败重试可绑定共享连接与匹配模型，保存不启动且重试带调用标识', async () => {
  for (const configuring of [true, false]) {
    actions.length = 0;
    const pending = configuring ? configureTask({ id: 50, role: 'worker', status: 'paused' }) : retryTask({ id: 50, role: 'worker', status: 'failed' });
    const label = configuring ? '保存设置' : '使用这些设置重试';
    await until(() => dialogButton(dom, label));
    const modal = dom.node('modal'), model = modal.querySelector('[data-retry-field="model"]');
    model.value = 'unsaved/model'; await dialogButton(dom, '读取项目连接').onclick(); expect(model.value).toBe('unsaved/model');
    const connection = modal.querySelector('[data-retry-field="connection_id"]'); connection.value = id; connection.onchange();
    expect(model.value).toBe('unsaved/model'); expect(deepText(modal)).toContain('此来源未设置默认模型');
    expect(modal.querySelector('[data-retry-field="model-choice"]').disabled).toBe(true);
    const choices = modal.querySelector('[data-connection-model="choice"]');
    expect(choices.children.map(node => node.value)).toEqual(['', 'openai-compatible/custom-model']);
    choices.value = 'openai-compatible/custom-model'; choices.onchange();
    expect(dialogButton(dom, label).classList.contains('agent-call')).toBe(!configuring);
    if (!configuring) expect(dialogButton(dom, label).getAttribute('data-help')).toContain('token');
    await dialogButton(dom, label).onclick(); expect(await pending).toBe(true);
    expect(actions).toHaveLength(1); expect(actions[0]).toMatchObject({ method: configuring ? 'worker.configure' : 'worker.retry',
      params: { id: 50, profile: { connection_id: id, model: 'openai-compatible/custom-model', agent: 'pi' } } });
  }
});

test('Worker 完整配置及重试在主动换源时填入默认模型，不改思考深度及其他编辑', async () => {
  managedConnections[0].default_model = 'custom-model'; managedConnections[0].default_thinking = 'high';
  managedConnections[1].default_model = 'gpt-5.4-mini';
  try {
    for (const configuring of [true, false]) {
      actions.length = 0;
      const pending = configuring ? configureTask({ id: 53, role: 'worker', status: 'paused' }) : retryTask({ id: 53, role: 'worker', status: 'failed' });
      const label = configuring ? '保存设置' : '使用这些设置重试';
      await until(() => dialogButton(dom, label));
      const modal = dom.node('modal'), get = name => modal.querySelector(`[data-retry-field="${name}"]`);
      expect(get('model').value).toBe(profile.model); // Opening does not apply the current source default.
      await dialogButton(dom, '读取项目连接').onclick(); expect(get('model').value).toBe(profile.model);
      get('append-prompt').value = 'keep this edit'; get('budget-tokens').value = '1000';
      get('connection_id').value = id; get('connection_id').onchange();
      expect(get('model').value).toBe('openai-compatible/custom-model');
      expect(get('thinking').value).toBe('medium');
      await dialogButton(dom, '读取项目连接').onclick(); expect(get('model').value).toBe('openai-compatible/custom-model');
      await dialogButton(dom, label).onclick(); expect(await pending).toBe(true);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ method: configuring ? 'worker.configure' : 'worker.retry', params: { profile: {
        connection_id: id, model: 'openai-compatible/custom-model', thinking: 'medium', append_prompt: 'keep this edit',
        soft_budget: { tokens: 1000 }, env: { ...commonEnv, ...roleEnv },
      } } });
    }
  } finally {
    delete managedConnections[0].default_model; delete managedConnections[0].default_thinking; delete managedConnections[1].default_model;
  }
});

test('Worker连接模型越界不提交，Codex切换不携带托管连接，加载默认恢复原连接和模型', async () => {
  actions.length = 0; profile.connection_id = id; const originalModel = profile.model; profile.model = 'openai-compatible/custom-model';
  try {
    const pending = configureTask({ id: 51, role: 'worker', status: 'paused' });
    await until(() => dialogButton(dom, '保存设置'));
    const modal = dom.node('modal'), connection = modal.querySelector('[data-retry-field="connection_id"]');
    await dialogButton(dom, '读取项目连接').onclick();
    connection.value = ''; connection.onchange(); modal.querySelector('[data-retry-field="model"]').value = 'edited';
    await dialogButton(dom, '加载默认参数').onclick();
    expect(connection.value).toBe(id); expect(modal.querySelector('[data-retry-field="model"]').value).toBe(profile.model);
    modal.querySelector('[data-retry-field="model"]').value = 'openai-compatible/not-allowed';
    await dialogButton(dom, '保存设置').onclick(); await until(() => dialogButton(dom, '保存设置'));
    expect(actions).toHaveLength(0); expect(dom.node('modal').querySelector('[data-retry-field="model"]').value).toBe('openai-compatible/not-allowed');
    expect(deepText(dom.node('modal'))).toContain('模型范围');
    await dialogButton(dom, '不修改').onclick(); expect(await pending).toBe(false);
    const switching = configureTask({ id: 51, role: 'worker', status: 'paused' });
    await until(() => dialogButton(dom, '保存设置'));
    const backend = dom.node('modal').querySelector('[data-retry-field="agent"]'); backend.value = 'codex'; backend.onchange();
    expect(dom.node('modal').querySelector('[data-retry-field="connection_id"]').disabled).toBe(true);
    await dialogButton(dom, '保存设置').onclick(); expect(await switching).toBe(true);
    expect(actions[0].params.profile).not.toHaveProperty('connection_id');
  } finally { profile.connection_id = codexId; profile.model = originalModel; }
});

test('Pi 默认模式只提交后端与模式，切回 Lush 保留未保存编辑', async () => {
  actions.length = 0;
  const pending = configureTask({ id: 47, role: 'worker', status: 'paused' });
  await until(() => dialogButton(dom, '保存设置'));
  const modal = dom.node('modal');
  const mode = modal.querySelector('[data-retry-field="config_mode"]');
  expect(mode.value).toBe('lush');
  const model = modal.querySelector('[data-retry-field="model"]');
  model.value = 'openai-codex/gpt-5.4-mini';
  mode.value = 'pi'; mode.onchange();
  expect(deepText(modal)).toContain('Pi 默认配置');
  expect(deepText(modal)).toContain('不自动批准未受信项目');
  expect(modal.querySelector('[data-config-managed="managed"]').hidden).toBe(true);
  expect(model.disabled).toBe(true);
  expect(modal.querySelector('[data-retry-field="agent"]').value).toBe('pi');
  // Pi 模式不需要连接与模型即可保存。
  await dialogButton(dom, '保存设置').onclick(); expect(await pending).toBe(true);
  expect(actions).toEqual([{ method: 'worker.configure', params: { id: 47, profile: { agent: 'pi', config_mode: 'pi' } } }]);
  // 切回 Lush 时仍保留刚才输入的模型，不被模式切换清空。
  actions.length = 0;
  const reopened = configureTask({ id: 48, role: 'worker', status: 'paused' });
  await until(() => dialogButton(dom, '保存设置'));
  const second = dom.node('modal'), secondMode = second.querySelector('[data-retry-field="config_mode"]');
  const secondModel = second.querySelector('[data-retry-field="model"]');
  secondModel.value = 'openai-codex/gpt-5.4-mini';
  secondMode.value = 'pi'; secondMode.onchange(); secondMode.value = 'lush'; secondMode.onchange();
  expect(second.querySelector('[data-config-managed="managed"]').hidden).toBe(false);
  expect(secondModel.value).toBe('openai-codex/gpt-5.4-mini');
  await dialogButton(dom, '不修改').onclick(); expect(await reopened).toBe(false);
  expect(actions).toHaveLength(0);
});

test('隔离的 explainer 角色不能切到 Pi 默认配置', async () => {
  actions.length = 0;
  const pending = configureTask({ id: 49, role: 'explainer', status: 'paused' });
  await until(() => dialogButton(dom, '保存设置'));
  const modal = dom.node('modal');
  const mode = modal.querySelector('[data-retry-field="config_mode"]');
  const piOption = [...mode.children].find(node => node.value === 'pi');
  expect(piOption.disabled).toBe(true);
  expect(deepText(modal)).toContain('隔离的 explainer / butler 必须使用 Lush 配置');
  await dialogButton(dom, '不修改').onclick(); expect(await pending).toBe(false);
  expect(actions).toHaveLength(0);
});

test('取消Worker配置后连接列表迟到不改变其他页面，也不发起重试', async () => {
  actions.length = 0; let resolve;
  connectionResponse = new Promise(done => { resolve = done; });
  const pending = configureTask({ id: 52, role: 'worker', status: 'paused' });
  await until(() => dialogButton(dom, '保存设置'));
  const loading = dialogButton(dom, '读取项目连接').onclick();
  await dialogButton(dom, '不修改').onclick(); expect(await pending).toBe(false);
  const before = deepText(dom.node('modal')); resolve(response({ version: 1, connections: managedConnections })); await loading;
  expect(deepText(dom.node('modal'))).toBe(before); expect(actions).toHaveLength(0); connectionResponse = null;
});

test('加载默认参数恢复角色的 Prompt、资源与软预算，并正确解析 scheduler 的 planner 环境', async () => {
  actions.length = 0; environmentReads.length = 0;
  const defaults = { ...profile, default_prompt: '角色默认 Prompt', append_prompt: '角色追加 Prompt',
    extensions: ['/tmp/review.js'], skills: ['/tmp/ui-skill'], soft_budget: { responses: 5, tokens: 1000 }, env: { SHARED: 'profile' } };
  settings.resolved.planner = defaults;
  settings.options.default_prompts.planner = '内置 planner Prompt';
  try {
    const pending = configureTask({ id: 46, role: 'scheduler', status: 'paused' });
    await until(() => dialogButton(dom, '保存设置'));
    const modal = dom.node('modal');
    expect(environmentReads).toEqual(['common', 'planner']);
    const get = name => modal.querySelector(`[data-retry-field="${name}"]`);
    get('default-prompt').value = 'changed'; get('append-prompt').value = 'changed';
    get('budget-responses').value = '9'; get('budget-tokens').value = '9000';
    for (const kind of ['extensions', 'skills']) {
      const checkbox = modal.querySelector(`[data-retry-resource="${kind}"]`);
      checkbox.checked = false; checkbox.onchange();
    }
    await dialogButton(dom, '加载默认参数').onclick();
    expect(get('default-prompt').value).toBe(defaults.default_prompt);
    expect(get('append-prompt').value).toBe(defaults.append_prompt);
    expect(get('budget-responses').value).toBe('5');
    expect(get('budget-tokens').value).toBe('1000');
    expect(modal.querySelector('[data-retry-resource="extensions"]').checked).toBe(true);
    expect(modal.querySelector('[data-retry-resource="skills"]').checked).toBe(true);
    await dialogButton(dom, '读取项目连接').onclick();
    await dialogButton(dom, '保存设置').onclick();
    expect(await pending).toBe(true);
    expect(actions).toEqual([{ method: 'worker.configure', params: { id: 46, profile: {
      ...defaults, config_mode: 'lush', env: { ...commonEnv, ...roleEnv, ...defaults.env },
    } } }]);
  } finally {
    delete settings.resolved.planner; delete settings.options.default_prompts.planner;
  }
});
