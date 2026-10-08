import { afterAll, expect, test } from 'bun:test';
import { deepText, installDom } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
afterAll(() => dom.restore());
const { createAgentConnectionPicker } = await import('../../src/ui/web/assets/agent-connection-picker.js');
const { createProfileForm } = await import('../../src/ui/web/assets/agent-profile-form.js');
const { createManagementProfileForm } = await import('../../src/ui/web/assets/management-profile-form.js');
const { renderAgentSettings } = await import('../../src/ui/web/assets/render-settings.js');
const source = world.state.agentConnections.connections[0];
const modelId = `openai-compatible/${source.models[0]}`;
const settings = () => {
  const config = structuredClone(world.state.agentConfig);
  Object.assign(config.default, { agent: 'pi', connection_id: source.id, model: modelId });
  config.resolved.manager = { ...config.default };
  return config;
};
const type = (input, value) => { input.value = value; for (const listener of input.listeners.input || []) listener(); input.oninput?.(); };
function grouped(root, model, candidates, connection) {
  const group = root.querySelector('.agent-connection-binding') || root;
  expect(group.tagName).toBe('FIELDSET');
  expect(group.querySelector('legend').textContent).toBe('模型来源与模型');
  const row = group.querySelector('.model-choice-row');
  expect(row.children).toHaveLength(2);
  expect(row.children[0].tagName).toBe('LABEL'); expect(row.children[0].querySelector('select')).toBe(candidates);
  expect(row.children[1].tagName).toBe('LABEL'); expect(row.children[1].querySelector('input')).toBe(model);
  expect(group.querySelector('.model-source-field').querySelector('select')).toBe(connection);
  expect(group.children.indexOf(row)).toBeGreaterThan(group.children.indexOf(connection.parentNode));
  expect(group.children.indexOf(group.querySelector('.model-source-actions'))).toBeGreaterThan(group.children.indexOf(row));
  expect(group.querySelectorAll('select')).toHaveLength(2); // 一个来源与一个候选，无重复模型控件
  for (let node = group.parentNode; node; node = node.parentNode) expect(node.tagName).not.toBe('LABEL');
}

test('来源、候选与名称共组；候选是输入快捷方式，手输、重读与不匹配状态同步且不丢草稿', async () => {
  const backend = dom.document.createElement('select'); backend.value = 'pi';
  const model = dom.document.createElement('input'); model.value = modelId;
  const picker = createAgentConnectionPicker({ backend, model, connectionId: source.id });
  picker.sync(); await picker.load();
  grouped(picker.node, model, picker.models, picker.connection);
  expect(picker.models.value).toBe(modelId);
  picker.models.value = 'openai-compatible/second-model'; picker.models.onchange();
  expect(model.value).toBe(picker.models.value); expect(picker.models.value).toBe('openai-compatible/second-model');
  type(model, ` ${modelId} `); expect(picker.models.value).toBe(modelId);
  type(model, 'openai-compatible/vendor/custom'); expect(picker.models.value).toBe('');
  expect(deepText(picker.node)).toContain('当前模型与此来源不匹配');
  await picker.load(); expect(model.value).toBe('openai-compatible/vendor/custom'); expect(picker.models.value).toBe('');
  type(model, modelId); expect(picker.validate()).toBeNull();
});

test('Codex CLI复用同一候选与名称行，留空默认及Pi来源选择保持原边界', async () => {
  const backend = dom.document.createElement('select'); backend.value = 'codex';
  const model = dom.document.createElement('input'); model.value = 'codex-a';
  const picker = createAgentConnectionPicker({ backend, model, connectionId: source.id });
  picker.setCliModels([{ id: 'codex-a' }, { id: 'codex-b', label: 'Codex B' }]); picker.sync();
  grouped(picker.node, model, picker.models, picker.connection);
  expect(picker.models.value).toBe('codex-a'); expect(picker.connection.disabled).toBe(true);
  picker.models.value = 'codex-b'; picker.models.onchange(); expect(model.value).toBe('codex-b');
  type(model, ''); expect(picker.models.value).toBe(''); expect(picker.validate()).toBeNull();
  backend.value = 'pi'; picker.sync(); await picker.load();
  expect(picker.value()).toBe(source.id); expect(model.value).toBe(''); expect(picker.validate()).toContain('请选择来源内模型');
  expect(picker.models.children.map(option => option.value)).not.toContain('codex-a');
});

test('完整运行设置使用唯一模型候选，已有名称选中同步，Pi默认模式隐藏整组', async () => {
  const form = createProfileForm({ profile: settings().default, settings: settings(), role: 'worker' });
  await form.ready; await form.picker.load();
  const model = form.node.querySelector('[data-retry-field="model"]');
  grouped(form.node, model, form.picker.models, form.picker.connection);
  expect(form.picker.models.value).toBe(modelId);
  expect(form.node.querySelector('[data-retry-field="model-choice"]')).toBeNull();
  const backend = form.node.querySelector('[data-retry-field="agent"]'); backend.value = 'codex'; backend.onchange();
  form.picker.models.value = 'gpt-5.4-mini'; form.picker.models.onchange(); expect(form.collect().model).toBe('gpt-5.4-mini');
  form.modeSelect.value = 'pi'; form.modeSelect.onchange();
  expect(model.disabled).toBe(true); expect(form.collect()).toEqual({ agent: 'pi', config_mode: 'pi' });
});

test('项目/角色Agent配置共用分组，模型编辑与目录选中同步，不覆盖其他字段', async () => {
  const root = renderAgentSettings(settings(), () => {});
  const card = root.querySelector('[data-agent-target="default"]');
  const model = card.querySelector('[data-agent-field="model"]');
  const candidates = card.querySelector('[data-connection-model="choice"]');
  const connection = card.querySelector('[data-agent-field="connection_id"]');
  grouped(card, model, candidates, connection);
  const load = card.querySelector('.model-source-actions').querySelector('button'); await load.onclick();
  type(model, 'openai-compatible/second-model'); expect(candidates.value).toBe(model.value);
  expect(card.querySelector('[data-agent-field="append_prompt"]').value).toBe(settings().default.append_prompt || '');
});

test('管理Agent把来源候选与名称放一起，忙碌与模式切换不丢名称', async () => {
  const form = createManagementProfileForm(settings()); await form.picker.load();
  const model = form.node.querySelector('input'); grouped(form.node, model, form.picker.models, form.picker.connection);
  type(model, 'openai-compatible/second-model'); expect(form.picker.models.value).toBe(model.value);
  form.setBusy(true); expect(model.disabled).toBe(true); expect(form.picker.models.disabled).toBe(true);
  form.setBusy(false); expect(form.picker.models.disabled).toBe(false);
  expect(form.collect().model).toBe('openai-compatible/second-model');
});
