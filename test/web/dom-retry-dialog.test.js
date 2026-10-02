import { test, expect, afterAll } from 'bun:test';
import { installDom, dialogButton, deepText } from '../dom-stub.js';
import { until } from '../helpers.js';

const actions = [];
const environmentReads = [];
const commonEnv = { SHARED: 'common', COMMON: 'only-common' };
const roleEnv = { SHARED: 'role', ROLE: 'only-role' };
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

  await dialogButton(dom, '使用这些设置重试').onclick();
  expect(await pending).toBe(true);
  expect(actions).toHaveLength(1);
  expect(actions[0]).toEqual({ method: 'worker.retry', params: { id: 42, profile: {
    agent: 'pi', model: 'openai-codex/gpt-5.4-mini', thinking: 'high', default_prompt: '',
    append_prompt: '先复盘错误，再做最小修复', extensions: ['/tmp/review.js'], skills: [], soft_budget: {}, env: { ...commonEnv, ...roleEnv },
  } } });
});

test('暂停中的「调整运行设置」只保存 Profile，不启动 Agent', async () => {
  actions.length = 0;
  const pending = configureTask({ id: 42, role: 'worker', status: 'paused' });
  await until(() => dialogButton(dom, '保存设置'));
  const modal = dom.node('modal');
  expect(deepText(modal)).toContain('点「继续」时生效');
  await dialogButton(dom, '保存设置').onclick();
  expect(await pending).toBe(true);
  expect(actions).toHaveLength(1);
  expect(actions[0].method).toBe('worker.configure');
  expect(actions[0].params.id).toBe(42);
  expect(actions[0].params.profile).toMatchObject({ agent: 'pi' });
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
    await dialogButton(dom, '保存设置').onclick();
    expect(await pending).toBe(true);
    expect(actions).toEqual([{ method: 'worker.configure', params: { id: 46, profile: {
      ...defaults, env: { ...commonEnv, ...roleEnv, ...defaults.env },
    } } }]);
  } finally {
    delete settings.resolved.planner; delete settings.options.default_prompts.planner;
  }
});
