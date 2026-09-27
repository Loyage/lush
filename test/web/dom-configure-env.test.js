import { test, expect, afterAll } from 'bun:test';
import { installDom, dialogButton, deepText } from '../dom-stub.js';
import { until } from '../helpers.js';

const actions = [];
const profile = { agent: 'pi', model: 'openai-codex/gpt-5.4', thinking: 'medium', default_prompt: '', append_prompt: '',
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
  expect(deepText(modal)).toContain('已暂停');
  expect(deepText(modal)).toContain('Pi 环境变量');

  const model = modal.querySelector('[data-retry-field="model"]');
  const env = modal.querySelector('[data-retry-field="env"]');
  model.value = 'openai-codex/gpt-5.4';
  env.value = 'API_BASE=https://example.invalid\n# 注释\nTOKEN=abc';
  await dialogButton(dom, '保存设置').onclick();
  expect(await pending).toBe(true);
  expect(actions).toHaveLength(1);
  expect(actions[0]).toEqual({ method: 'task.configure', params: { id: 43, profile: {
    agent: 'pi', model: 'openai-codex/gpt-5.4', thinking: 'medium', default_prompt: '',
    append_prompt: '', extensions: [], skills: [], soft_budget: {}, env: { API_BASE: 'https://example.invalid', TOKEN: 'abc' },
  } } });
});

test('parseEnvLines keeps values with = and rejects lines without a name', () => {
  expect(parseEnvLines('A=1\nB=x=y\n# skip\n\n')).toEqual({ A: '1', B: 'x=y' });
  expect(() => parseEnvLines('NOVALUE')).toThrow('NAME=value');
});
