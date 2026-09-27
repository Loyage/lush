import { test, expect, afterAll } from 'bun:test';
import { installDom, dialogButton, deepText } from '../dom-stub.js';
import { until } from '../helpers.js';

const actions = [];
const profile = { agent: 'pi', model: 'openai-codex/gpt-5.4', thinking: 'medium', default_prompt: '', append_prompt: '',
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
const { retryTask } = await import('../../src/ui/web/assets/retry-dialog.js');

afterAll(() => { restoreNavigation(); dom.restore(); });

test('检查后重试编辑完整 Profile，并只把覆盖参数提交给 task.retry', async () => {
  const pending = retryTask({ id: 42, role: 'worker', status: 'failed' });
  await until(() => dialogButton(dom, '使用这些设置重试'));
  const modal = dom.node('modal');
  expect(deepText(modal)).toContain('只用于本轮重试');
  expect(deepText(modal)).toContain('默认 Prompt');
  expect(deepText(modal)).toContain('扩展与 Skills');

  const model = modal.querySelector('[data-retry-field="model"]');
  const thinking = modal.querySelector('[data-retry-field="thinking"]');
  const appendPrompt = modal.querySelector('[data-retry-field="append-prompt"]');
  model.value = 'openai-codex/gpt-5.4-mini'; thinking.value = 'high'; appendPrompt.value = '先复盘错误，再做最小修复';
  const extension = modal.querySelector('[data-retry-resource="extensions"]');
  extension.checked = true; extension.onchange();

  await dialogButton(dom, '使用这些设置重试').onclick();
  expect(await pending).toBe(true);
  expect(actions).toHaveLength(1);
  expect(actions[0]).toEqual({ method: 'task.retry', params: { id: 42, profile: {
    agent: 'pi', model: 'openai-codex/gpt-5.4-mini', thinking: 'high', default_prompt: '',
    append_prompt: '先复盘错误，再做最小修复', extensions: ['/tmp/review.js'], skills: [], soft_budget: {},
  } } });
});
