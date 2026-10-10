import { afterAll, expect, test } from 'bun:test';
import { deepText, dialogButton, findByText, installDom } from '../dom-stub.js';

const json = value => ({ ok: true, status: 200, json: async () => value?.connections ? { ...value, configuration_scope: { selected: 'device', source: 'device', project_override: false } } : value });
const notFound = () => ({ ok: false, status: 404, json: async () => ({ error: 'no route /api/agent/packages' }) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

const connectionId = '11111111-1111-4111-8111-111111111111';
const connection = { id: connectionId, label: '中转 API', provider: 'openai-compatible', endpoint: 'https://models.example/v1',
  auth_type: 'api_key', enabled: true, models: ['fixture-model'], credential: { status: 'configured' } };
const catalog = { version: 1, id: connectionId, checked_at: '2026-10-01T09:00:00.000Z', status: 'fresh', source: 'provider_list',
  models: [{ id: 'openai-compatible/fixture-model', name: 'Fixture', thinking_levels: ['minimal', 'medium', 'high'] }] };
const packagesFixture = () => ({ version: 1,
  packages: [{ id: 'pkg-1', source: 'npm:example@1.0.0', label: 'Example 工具', version: '1.0.0', root: '/tmp/demo/.lush/pi/npm/example' }],
  resources: { extensions: [{ name: 'review helper', path: '/tmp/demo/.lush/pi/extensions/review.ts', source: 'npm:example@1.0.0', package_id: 'pkg-1' }],
    skills: [{ name: 'browser', path: '/tmp/demo/.lush/pi/skills/browser/SKILL.md', description: '浏览器自动化', package_id: 'pkg-1' }] },
  warning: null });
const legacyFixture = () => ({ agent: 'pi', warning: null, packages: [{ source: 'npm:legacy', root: '/tmp/demo/.lush/pi/npm/legacy' }],
  extensions: [{ id: '/tmp/demo/.lush/pi/extensions/legacy.ts', label: 'legacy.ts', source: 'Lush 独立 Pi 扩展' }], skills: [] });
const settingsFixture = () => ({
  version: 1, file: '/tmp/demo/.lush/agent.json', runtime_agent: 'pi',
  default: { agent: 'pi', connection_id: connectionId, model: 'openai-compatible/fixture-model', thinking: 'medium',
    default_prompt: '', append_prompt: '保持改动可审阅。', extensions: [], skills: [], soft_budget: { responses: 5 } },
  roles: {}, resolved: { agent: { agent: 'pi', connection_id: connectionId, model: 'openai-compatible/fixture-model', thinking: 'medium',
    default_prompt: '', append_prompt: '', extensions: [], skills: [] } },
  options: { agents: ['pi', 'codex'], roles: [{ id: 'agent', label: '直接 Worker' }],
    thinking: { pi: ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], codex: ['', 'minimal', 'low', 'medium', 'high'] },
    models: { pi: ['openai-compatible/fixture-model'], codex: ['gpt-5.4'] },
    default_prompt: '内置 Prompt', default_prompts: { agent: '内置 agent Prompt' } },
});

let actions = [], packagesMode = 'ok', packagesPending = null, resourcesCalls = 0;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url).replace('/api/host/settings/', '/api/').replace(/[?&]scope=device$/, '');
  if (path === '/api/agent/connections') return json({ version: 1, connections: [connection] });
  if (path.startsWith('/api/agent/connections/models')) return json(catalog);
  if (path === '/api/agent/packages') {
    if (packagesPending) return packagesPending.promise;
    if (packagesMode === 'missing') return notFound();
    return json(packagesFixture());
  }
  if (path === '/api/agent/resources') { resourcesCalls++; return json(legacyFixture()); }
  if (path === '/api/action') { const body = JSON.parse(options.body); actions.push(body); return json({ ok: true }); }
  return { ok: false, status: 404, json: async () => ({ error: `no route ${path}` }) };
} });
dom.document.createElementNS = (_ns, tag) => dom.document.createElement(tag);
const { renderAgentSettings } = await import('../../src/ui/web/assets/render-settings.js');
const { createProfileForm } = await import('../../src/ui/web/assets/agent-profile-form.js');
afterAll(() => dom.restore());

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const render = (owns = () => true) => renderAgentSettings(settingsFixture(), () => {}, { ownsPage: owns });
const profile = root => root.querySelector('[data-agent-target="default"]');
const packagesBlock = root => [...root.querySelectorAll('.block')].find(node => node.querySelector('h2')?.textContent === '已安装插件与 Skills');
const byButton = (root, label) => [...root.querySelectorAll('button')].find(node => node.textContent === label) || null;
const click = async node => { await node.onclick(); await settle(); };
const reloadPackages = async root => {
  const block = packagesBlock(root);
  const button = byButton(block, '读取已安装包') || byButton(block, '重新读取');
  await click(button); return packagesBlock(root);
};

test('默认 Lush 模式：托管字段可见，保存提交完整 Profile 并带 config_mode', async () => {
  actions = []; packagesMode = 'ok'; packagesPending = null;
  const root = render(); const card = profile(root); await settle();
  expect(card.querySelector('[data-agent-field="config_mode"]').value).toBe('lush');
  expect(card.dataset.configMode).toBe('lush');
  expect(card.querySelector('[data-agent-managed="true"]').hidden).toBe(false);
  expect(card.querySelector('details.agent-config-section').hidden).toBe(false);
  await click(findByText(card, '保存配置'));
  const saved = actions.at(-1).params.config.default;
  expect(actions.at(-1).method).toBe('agent.configure');
  expect(saved).toMatchObject({ config_mode: 'lush', connection_id: connectionId, model: 'openai-compatible/fixture-model',
    thinking: 'medium', append_prompt: '保持改动可审阅。', soft_budget: { responses: 5 } });
});

test('Pi 默认模式：清除并隐藏托管字段，只提交后端与模式，说明执行机器 Pi 语义', async () => {
  actions = []; packagesMode = 'ok'; packagesPending = null;
  const root = render(); const card = profile(root); await settle();
  const mode = card.querySelector('[data-agent-field="config_mode"]');
  mode.value = 'pi'; await mode.listeners.change[0]();
  expect(card.dataset.configMode).toBe('pi');
  const backend = card.querySelector('[data-agent-field="agent"]');
  expect(backend.value).toBe('pi'); expect(backend.disabled).toBe(true);
  expect(card.querySelector('[data-agent-field="model"]').value).toBe('');
  expect(card.querySelector('[data-agent-field="connection_id"]').value).toBe('');
  expect(card.querySelector('[data-agent-field="thinking"]').value).toBe('');
  expect(card.querySelector('textarea[data-agent-field="default_prompt"]').value).toBe('');
  expect(card.querySelector('textarea[data-agent-field="append_prompt"]').value).toBe('');
  expect(card.querySelector('[data-agent-managed="true"]').hidden).toBe(true);
  for (const details of card.querySelectorAll('details.agent-config-section')) expect(details.hidden).toBe(true);
  expect(deepText(card)).toContain('Pi 默认配置由执行机器的 Pi 目录自行管理');
  expect(deepText(card)).toContain('不自动批准未受信项目');
  await click(findByText(card, '保存配置'));
  expect(actions.at(-1).params.config.default).toEqual({ agent: 'pi', config_mode: 'pi' });
});

test('Pi 模式不提交托管字段；切回 Lush 恢复原后端并保留未保存的其他编辑', async () => {
  actions = []; packagesMode = 'ok'; packagesPending = null;
  const root = render(); const card = profile(root); await settle();
  const backend = card.querySelector('[data-agent-field="agent"]');
  const mode = card.querySelector('[data-agent-field="config_mode"]');
  backend.value = 'codex'; await backend.listeners.change[0]();
  expect(backend.value).toBe('codex');
  mode.value = 'pi'; await mode.listeners.change[0]();
  expect(backend.value).toBe('pi');
  await click(findByText(card, '保存配置'));
  const piSaved = actions.at(-1).params.config.default;
  expect(piSaved).toEqual({ agent: 'pi', config_mode: 'pi' });
  expect(Object.keys(piSaved)).toHaveLength(2);
  mode.value = 'lush'; await mode.listeners.change[0]();
  expect(card.querySelector('[data-agent-field="agent"]').value).toBe('codex');
  expect(card.querySelector('[data-agent-field="agent"]').disabled).toBe(false);
  const append = card.querySelector('textarea[data-agent-field="append_prompt"]');
  append.value = '未保存的补充'; await click(findByText(card, '保存配置'));
  const lushSaved = actions.at(-1).params.config.default;
  expect(lushSaved.config_mode).toBe('lush');
  expect(lushSaved.append_prompt).toBe('未保存的补充');
});

test('已安装包：未固定来源被拒绝且不发请求；固定来源安装成功后重新读取并清空输入', async () => {
  actions = []; packagesMode = 'ok'; packagesPending = null;
  const root = render(); await settle();
  const block = await reloadPackages(root);
  expect(deepText(block)).toContain('安装与启用分开');
  expect(deepText(block)).toContain('Example 工具');
  const source = block.querySelector('input[data-package-source]');
  source.value = 'npm:example';
  await click(byButton(block, '安装'));
  expect(actions).toHaveLength(0);
  expect(deepText(block)).toContain('npm 包必须固定版本');
  source.value = 'npm:example@2.0.0';
  await click(byButton(block, '安装'));
  expect(actions).toEqual([{ method: 'agent.packages.install', params: { scope: 'device', source: 'npm:example@2.0.0' } }]);
  expect(source.value).toBe('');
  source.value = 'git:github.com/example/tools';
  await click(byButton(block, '安装'));
  expect(actions).toHaveLength(1);
  expect(deepText(block)).toContain('git 来源必须固定 commit 或 tag');
  source.value = './local-package';
  await click(byButton(block, '安装'));
  expect(actions.at(-1)).toEqual({ method: 'agent.packages.install', params: { scope: 'device', source: './local-package' } });
});

test('已安装包：更新与移除调用用户专属动作，移除需确认且取消不提交', async () => {
  actions = []; packagesMode = 'ok'; packagesPending = null;
  const root = render(); await settle();
  const block = await reloadPackages(root);
  await click(byButton(block, '更新'));
  expect(actions.at(-1)).toEqual({ method: 'agent.packages.update', params: { scope: 'device', id: 'pkg-1' } });
  const removing = byButton(block, '移除').onclick(); await settle();
  expect(deepText(dom.node('modal'))).toContain('不会删除用户默认 Pi 的安装');
  await dialogButton(dom, '取消').onclick(); await removing; await settle();
  expect(actions).toHaveLength(1);
  const confirmed = byButton(block, '移除').onclick(); await settle();
  await dialogButton(dom, '移除该包').onclick(); await confirmed; await settle();
  expect(actions.at(-1)).toEqual({ method: 'agent.packages.remove', params: { scope: 'device', id: 'pkg-1' } });
});

test('后端不可用时退回只读目录：明确提示、禁用安装更新、仍列出发现到的包', async () => {
  actions = []; packagesMode = 'missing'; packagesPending = null; resourcesCalls = 0;
  const root = render(); await settle();
  const block = await reloadPackages(root);
  expect(resourcesCalls).toBeGreaterThan(0);
  expect(deepText(block)).toContain('已安装包管理不可用');
  expect(deepText(block)).toContain('只读目录发现');
  const install = byButton(block, '安装');
  expect(install.disabled).toBe(true);
  expect(install.parentNode.getAttribute('data-help')).toContain('没有提供安装管理接口');
  expect(byButton(block, '更新').disabled).toBe(true);
  expect(deepText(block)).toContain('npm:legacy');
});

test('资源启用复选框使用 packages 的 path，启用与安装分离，保存写入显式路径', async () => {
  actions = []; packagesMode = 'ok'; packagesPending = null;
  const root = render(); const card = profile(root); await settle();
  await click(findByText(card, '读取已安装项'));
  const extension = card.querySelector('input[data-resource-kind="extensions"]');
  expect(extension.value).toBe('/tmp/demo/.lush/pi/extensions/review.ts');
  expect(extension.checked).toBe(false);
  extension.checked = true; await extension.listeners.change[0]();
  await click(findByText(card, '保存配置'));
  expect(actions.at(-1).params.config.default.extensions).toEqual(['/tmp/demo/.lush/pi/extensions/review.ts']);
  expect(deepText(card)).toContain('已安装插件与 Skills');
});

test('插件管理显示可启用入口及完整路径，说明 MCP 服务不是 Pi 扩展', async () => {
  packagesMode = 'ok'; packagesPending = null;
  const root = render(); await settle();
  const block = await reloadPackages(root);
  const details = block.querySelector('details[data-package-resources=""]');
  expect(deepText(details)).toContain('可启用资源：1 个扩展 · 1 个 Skill');
  expect(deepText(details)).toContain('/tmp/demo/.lush/pi/extensions/review.ts');
  expect(deepText(details)).toContain('独立 MCP 服务不作为 Pi 扩展加载');
  const card = profile(root);
  await click(findByText(card, '读取已安装项'));
  expect(deepText(card)).toContain('不必勾选目录内所有脚本');
  expect(deepText(card.querySelector('.resource-choice'))).toContain('/tmp/demo/.lush/pi/extensions/review.ts');
});

test('旧配置中的未发现路径保留并警告，用户可明确取消而非静默迁移', async () => {
  actions = []; packagesMode = 'ok'; packagesPending = null;
  const settings = settingsFixture();
  const obsolete = '/tmp/demo/.lush/pi/npm/example/dist/mcp-cli.js';
  settings.default.extensions = [obsolete];
  const root = renderAgentSettings(settings, () => {}, { ownsPage: () => true });
  await settle(); const card = profile(root);
  await click(findByText(card, '读取已安装项'));
  const row = [...card.querySelectorAll('.resource-choice')].find(node => node.classList.contains('missing'));
  expect(deepText(row)).toContain('请核对入口路径或取消勾选');
  const checkbox = row.querySelector('input');
  expect(checkbox.checked).toBe(true);
  checkbox.checked = false; await checkbox.listeners.change[0]();
  await click(findByText(card, '保存配置'));
  expect(actions.at(-1).params.config.default.extensions).toEqual([]);
});

test('Worker 共用表单也展示入口路径、MCP 提示并保留旧选择供明确取消', async () => {
  packagesMode = 'ok'; packagesPending = null;
  const settings = settingsFixture();
  const obsolete = '/tmp/demo/.lush/pi/npm/example/dist/mcp-cli.js';
  const available = '/tmp/demo/.lush/pi/extensions/review.ts';
  const form = createProfileForm({ profile: { ...settings.default, extensions: [obsolete] },
    defaultProfile: { ...settings.default, extensions: [available] }, settings, role: 'agent', collapseAdvanced: true });
  await form.ready;
  const advanced = form.node.querySelector('[data-retry-advanced="settings"]');
  expect(advanced.tagName).toBe('DETAILS');
  expect(Boolean(advanced.open)).toBe(false);
  expect(form.collect().extensions).toEqual([obsolete]);
  expect(deepText(form.node)).toContain('独立 MCP 服务不是 Pi 扩展');
  expect(deepText(form.node)).toContain('/tmp/demo/.lush/pi/extensions/review.ts');
  const checkbox = [...form.node.querySelectorAll('input[data-retry-resource="extensions"]')].find(input => input.value === obsolete);
  expect(checkbox.checked).toBe(true);
  expect(deepText(checkbox.parentNode)).toContain('请核对入口路径或取消勾选');
  expect([...advanced.querySelectorAll('input[data-retry-resource="extensions"]')]).toContain(checkbox);
  advanced.open = true;
  checkbox.checked = false; checkbox.onchange();
  expect(form.collect().extensions).toEqual([]);
  form.reset();
  expect(form.collect().extensions).toEqual([available]);
  expect([...advanced.querySelectorAll('input[data-retry-resource="extensions"]')].some(input => input.value === obsolete)).toBe(false);
});

test('目录迟到响应不覆盖用户正在填写的安装来源，也不在离页后重画', async () => {
  actions = []; packagesMode = 'ok';
  const pending = deferred(); packagesPending = pending;
  let current = true;
  const root = render(() => current); await settle();
  const block = packagesBlock(root);
  const source = block.querySelector('input[data-package-source]');
  source.value = 'npm:example@9.9.9';
  current = false;
  pending.resolve(json(packagesFixture())); packagesPending = null;
  await settle();
  expect(source.value).toBe('npm:example@9.9.9');
});

test('项目默认 Pi 模式：已保存摘要求说明执行机器 Pi，不展示托管来源或模型', async () => {
  actions = []; packagesMode = 'ok'; packagesPending = null;
  const settings = settingsFixture();
  settings.default = { agent: 'pi', config_mode: 'pi' };
  settings.resolved.agent = { ...settings.default };
  const root = renderAgentSettings(settings, () => {}, { ownsPage: () => true });
  await settle();
  const card = profile(root);
  expect(card.querySelector('[data-agent-field="config_mode"]').value).toBe('pi');
  expect(card.dataset.configMode).toBe('pi');
  const summary = root.querySelector('.agent-default-summary');
  expect(summary.textContent).toContain('Pi 默认配置');
  expect(summary.textContent).toContain('执行机器 Pi');
  expect(summary.textContent).not.toContain(connectionId);
});
