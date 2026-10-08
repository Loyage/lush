import { el, button } from './dom.js';
import { createAgentConnectionPicker } from './agent-connection-picker.js';
import { CONFIG_MODES, normalizeConfigMode, profileForMode } from './agent-config-mode.js';

const option = (value, text) => { const node = el('option', text); node.value = value; return node; };
const field = (label, input) => {
  const node = el('label', undefined, 'hook-field'); input.setAttribute('aria-label', label);
  node.append(el('span', label), input); return node;
};

/** Manager selection deliberately has no development Prompt, extensions, skills or env controls. */
export function createManagementProfileForm(settings, { ownsPage = () => true } = {}) {
  const initial = settings.resolved?.manager || settings.default || {};
  const compatible = !initial.agent || initial.agent === 'pi';
  const node = el('div', undefined, 'management-profile-form hook-form');
  const mode = el('select'); mode.replaceChildren(...CONFIG_MODES.map(item => option(item.id, item.label)));
  mode.value = normalizeConfigMode(initial.config_mode);
  const managed = el('div', undefined, 'hook-profile');
  const backend = el('select'); backend.append(option('pi', 'Pi')); backend.value = 'pi';
  const model = el('input'); model.maxLength = 256; model.value = compatible ? initial.model || '' : '';
  const thinking = el('select');
  const levels = settings.options?.thinking?.pi || [''];
  thinking.replaceChildren(...levels.map(value => option(value, value || '默认')));
  thinking.value = compatible && levels.includes(initial.thinking) ? initial.thinking : '';
  let busy = false;
  const applyMode = () => {
    managed.hidden = mode.value === 'pi';
    for (const tag of ['input', 'select', 'button']) for (const control of managed.querySelectorAll(tag)) control.disabled = busy || mode.value === 'pi';
    mode.disabled = busy;
    picker.models.disabled = busy || mode.value === 'pi' || !picker.value() || picker.entry()?.enabled === false || picker.models.children.length <= 1;
  };
  const picker = createAgentConnectionPicker({ backend, model, connectionId: compatible ? initial.connection_id || '' : '', ownsPage,
    applyDefaultModelOnChange: true, onChange: applyMode });
  picker.connection.setAttribute('aria-label', '管理 Agent 模型来源');
  const fill = button('填入来源默认模型与思考深度', () => {
    if (!ownsPage() || busy) return;
    const source = picker.entry();
    if (source?.default_model) model.value = `${source.provider}/${source.default_model}`;
    if (source?.default_thinking && levels.includes(source.default_thinking)) thinking.value = source.default_thinking;
    picker.sync(); applyMode();
  }, 'ghost', { help: '将已选择来源的默认模型和思考深度填入管理 Agent 表单，不查询额度、不启动调用；保存前可修改。' });
  model.setAttribute('aria-label', '管理 Agent 模型名称');
  picker.actions.append(fill);
  managed.append(picker.node, field('管理 Agent 思考深度', thinking));
  node.append(field('管理 Agent 配置模式', mode), el('p', '管理 Agent 使用独立提示词及查询／开始／重试工具，不加载开发 Prompt、扩展、Skills 或环境变量。仅支持 Pi 后端；可在 Pi 中选择 Codex 模型来源。管理来源与目标 Worker 的账号独立，不自动切换账号。', 'hint'), managed,
    el('p', 'Pi 默认配置模式使用执行机器的模型与认证，但仍限制为管理工具，不继承开发上下文。此表单只保存后续调用设置，不立即调用 Agent。', 'hint'));
  mode.onchange = applyMode; applyMode(); picker.sync();
  return { node, picker, ready: Promise.resolve(),
    setBusy(value) { busy = value; applyMode(); },
    validate: () => mode.value === 'pi' ? '' : picker.validate() || '',
    collect: () => mode.value === 'pi' ? profileForMode('pi', { agent: 'pi' }) : profileForMode('lush', {
      agent: 'pi', connection_id: picker.value(), model: model.value.trim(), thinking: thinking.value,
    }),
  };
}
