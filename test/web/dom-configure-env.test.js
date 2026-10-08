import { test, expect, afterAll } from 'bun:test';
import { installDom, dialogButton, deepText } from '../dom-stub.js';
import { until } from '../helpers.js';

const actions = [];
const environmentReads = [];
let environmentError = null;
const commonValues = { API_BASE: 'https://common.invalid', COMMON_ONLY: 'shared' };
const roleValues = { API_BASE: 'https://agent.invalid', TOKEN: 'abc', EMPTY: '', MULTILINE: 'first\nsecond', SPACED: ' padded ', QUOTED: '"literal"', PATH_VALUE: 'C:\\tools' };
const connectionId = '55555555-5555-4555-8555-555555555555';
const profile = { agent: 'pi', connection_id: connectionId, model: 'openai-codex/gpt-5.4', thinking: 'medium', default_prompt: '', append_prompt: '',
  extensions: [], skills: [], soft_budget: {} };
const settings = {
  version: 1, default: profile, roles: {}, resolved: { agent: profile },
  options: {
    agents: ['pi', 'codex'], thinking: { pi: ['', 'low', 'medium', 'high'], codex: ['', 'low', 'high'] },
    models: { pi: ['openai-codex/gpt-5.4'], codex: ['gpt-5.4-mini'] },
    default_prompts: { agent: '内置 agent Prompt' }, default_prompt: '默认 Prompt',
  },
};
const response = value => ({ ok: true, status: 200, json: async () => value });
const dom = installDom({ fetch: async (url, options = {}) => {
  if (url === '/api/agent/config') return response(settings);
  if (/^\/api\/worker\/\d+\/run-settings$/.test(url)) return response({ profile, explicit: false });
  if (url === '/api/agent/connections') return response({ version: 1, connections: [
    { id: connectionId, label: 'Lush Codex OAuth', provider: 'openai-codex', auth_type: 'oauth', enabled: true,
      models: ['gpt-5.4'], credential: { status: 'configured' } },
  ] });
  if (url.startsWith('/api/agent/environment?target=')) {
    const target = new URL(url, 'http://localhost').searchParams.get('target');
    environmentReads.push(target);
    if (environmentError) return { ok: false, status: 400, json: async () => ({ error: environmentError }) };
    return response({ target, values: target === 'common' ? commonValues : roleValues });
  }
  if (url.startsWith('/api/agent/models')) return response({ models: [] });
  if (url === '/api/agent/resources') return response({ extensions: [], skills: [], warning: null });
  if (url === '/api/action') { actions.push(JSON.parse(options.body)); return response({ status: 'queued' }); }
  return response({});
} });
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const restoreNavigation = registerNavigation({ refresh: async () => {}, detail: async () => {}, overview: async () => {}, graph: async () => {} });
const { configureTask, parseEnvLines } = await import('../../src/ui/web/assets/retry-dialog.js');

afterAll(() => { restoreNavigation(); dom.restore(); });

test('configureTask 保存 paused 任务的本轮运行设置，并把按任务的 Pi 环境变量一起提交', async () => {
  const pending = configureTask({ id: 43, role: 'agent', status: 'paused' });
  await until(() => dialogButton(dom, '保存设置'));
  const modal = dom.node('modal');
  expect(deepText(modal)).toContain('下一次 Agent 调用');
  expect(deepText(modal)).toContain('Pi 环境变量');

  const model = modal.querySelector('[data-retry-field="model"]');
  const env = modal.querySelector('[data-retry-field="env"]');
  expect(environmentReads).toEqual(['common', 'agent']);
  expect(parseEnvLines(env.value)).toEqual({ ...commonValues, ...roleValues });
  model.value = 'openai-codex/gpt-5.4';
  env.value = 'API_BASE=https://example.invalid\n# 注释\nTOKEN=abc';
  await dialogButton(dom, '读取项目连接').onclick();
  await dialogButton(dom, '保存设置').onclick();
  expect(await pending).toBe(true);
  expect(actions).toHaveLength(1);
  expect(actions[0]).toEqual({ method: 'worker.configure', params: { id: 43, profile: {
    agent: 'pi', config_mode: 'lush', connection_id: connectionId, model: 'openai-codex/gpt-5.4', thinking: 'medium', default_prompt: '',
    append_prompt: '', extensions: [], skills: [], soft_budget: {}, env: { API_BASE: 'https://example.invalid', TOKEN: 'abc' },
  } } });
});

test('待开始任务可加载全部默认参数，含公共与角色环境变量；不保存或调用 Agent', async () => {
  actions.length = 0;
  const pending = configureTask({ id: 44, role: 'agent', status: 'paused', calls: 0 });
  await until(() => dialogButton(dom, '保存设置'));
  const modal = dom.node('modal');
  const get = name => modal.querySelector(`[data-retry-field="${name}"]`);
  get('agent').value = 'codex'; get('agent').onchange();
  get('model').value = 'custom'; get('thinking').value = 'high';
  get('default-prompt').value = 'changed'; get('append-prompt').value = 'changed';
  get('budget-responses').value = '10'; get('budget-tokens').value = '1000';
  get('env').value = 'LOCAL=changed';
  const restore = dialogButton(dom, '加载默认参数');
  expect(restore.classList.contains('agent-call')).toBe(false);
  expect(restore.getAttribute('data-help')).toContain('全部改动');
  await restore.onclick();
  expect(actions).toHaveLength(0);
  expect(get('agent').value).toBe('pi');
  expect(get('model').value).toBe(profile.model);
  expect(get('thinking').value).toBe('medium');
  expect(get('default-prompt').value).toBe('内置 agent Prompt');
  expect(get('append-prompt').value).toBe('');
  expect(get('budget-responses').value).toBe('');
  expect(get('budget-tokens').value).toBe('');
  expect(get('budget-tokens').disabled).toBe(false);
  expect(parseEnvLines(get('env').value)).toEqual({ ...commonValues, ...roleValues });
  await dialogButton(dom, '读取项目连接').onclick();
  await dialogButton(dom, '保存设置').onclick();
  expect(await pending).toBe(true);
  expect(actions).toEqual([{ method: 'worker.configure', params: { id: 44, profile: {
    ...profile, config_mode: 'lush', env: { ...commonValues, ...roleValues },
  } } }]);
});

test('默认环境变量读取失败不打开缺失参数的表单，也不保存设置', async () => {
  actions.length = 0;
  environmentError = 'unsafe agent environment file';
  try {
    expect(await configureTask({ id: 45, role: 'agent', status: 'paused' })).toBe(false);
    expect(dialogButton(dom, '保存设置')).toBeNull();
    expect(actions).toHaveLength(0);
    expect(dom.node('error').textContent).toContain('unsafe agent environment file');
    expect(dom.node('error').textContent).not.toContain('abc');
  } finally { environmentError = null; }
});

test('parseEnvLines keeps values with = and rejects lines without a name', () => {
  expect(parseEnvLines('A=1\nB=x=y\n# skip\n\n')).toEqual({ A: '1', B: 'x=y' });
  expect(parseEnvLines('MULTILINE="first\\nsecond"\nSPACE=" padded "\nQUOTE="\\\"literal\\\""')).toEqual({ MULTILINE: 'first\nsecond', SPACE: ' padded ', QUOTE: '"literal"' });
  expect(() => parseEnvLines('NOVALUE')).toThrow('NAME=value');
});
