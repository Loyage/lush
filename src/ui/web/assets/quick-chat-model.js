import { el, button } from './dom.js';
import { settingsClient } from './settings-api.js';
import { scopeSummary } from './settings-scope.js';
import { createModelChoice } from './model-choice.js';

const PROVIDERS = new Set(['openai-compatible', 'deepseek', 'openrouter', 'zai']);
const option = (value, text) => { const node = el('option', text); node.value = value; return node; };
const field = (tag, name) => { const node = el(tag); node.dataset.quickField = name; return node; };
const label = (text, control) => { const node = el('label'); node.append(el('span', text), control); return node; };

/** Device model selection embedded in project chat settings; never reads history or calls a model. */
export function renderChatModel({ container, ownsPage }) {
  const client = settingsClient(), root = el('section', undefined, 'quick-chat-model'), owner = globalThis.document;
  const owns = () => owner === globalThis.document && ownsPage();
  let pending = null;
  root.append(el('h2', '共用模型配置'), el('p', '这里的模型来源与模型由所有项目共用。保存不调用模型，已创建对话继续沿用原模型快照；Prompt 在上方按项目独立管理。', 'hint'));
  const settings = el('div'); root.append(settings); container.replaceChildren(root);
  function load() {
    if (!owns()) return Promise.resolve(); if (pending) return pending;
    settings.replaceChildren(el('p', '正在读取设备模型配置…', 'hint'));
    pending = (async () => { try {
      const [config, data] = await Promise.all([client.read('/api/quick-explain/config'), client.read('/api/agent/connections')]);
      if (!owns()) return;
      const entries = (data.connections || []).filter(row => row.enabled && row.auth_type === 'api_key' && PROVIDERS.has(row.provider));
      const connection = field('select', 'connection_id'), model = field('input', 'model'), candidates = field('select', 'model_choice');
      const choice = createModelChoice({ model, candidates });
      connection.append(option('', '请选择模型来源'));
      for (const row of entries) connection.append(option(row.id, `${row.label} · ${row.provider}${row.credential?.status === 'configured' ? '' : '（凭证未就绪）'}`));
      if (config.connection_id && !entries.some(row => row.id === config.connection_id)) connection.append(option(config.connection_id, '已配置来源不可用，请重新选择'));
      connection.value = config.connection_id || ''; model.value = config.model || ''; model.placeholder = '物理模型 ID，例如 deepseek-chat';
      const note = el('p', '', 'hint'), status = el('p', config.ready ? '本地配置就绪；不代表 API 已联网验证。' : config.reason || '请选择来源和模型后保存。', 'hint'); status.setAttribute('role', 'status');
      const catalogue = new Map(); let generation = 0, saving = false, edits = 0;
      const chosen = () => entries.find(row => row.id === connection.value);
      function paint() {
        const row = chosen(), models = row?.models?.length ? row.models : catalogue.get(row?.id) || [];
        candidates.replaceChildren(option('', models.length ? '选择此来源的模型…' : '无缓存候选，可手填模型 ID'));
        for (const value of [...new Set(models)]) candidates.append(option(value, value));
        candidates.disabled = !models.length; choice.sync();
        note.textContent = row ? `${row.label} · ${row.endpoint}。模型为物理 ID，不带 ${row.provider}/ 前缀；来源或候选变化不会替换当前输入。${row.models?.length && model.value && !row.models.includes(model.value.trim()) ? ' 当前模型不在来源范围内，请修正后保存。' : ''}` : '支持 OpenAI 兼容 Chat Completions API Key 来源，不支持 Codex OAuth 或 Kimi Coding 协议。';
      }
      async function loadCatalog() {
        paint(); const row = chosen(), ticket = ++generation;
        if (!row || row.models?.length || catalogue.has(row.id)) return;
        try {
          const cached = await client.read(`/api/agent/connections/models?id=${encodeURIComponent(row.id)}`);
          if (!owns() || ticket !== generation) return;
          const prefix = `${row.provider}/`;
          catalogue.set(row.id, (cached.models || []).map(entry => typeof entry.id === 'string' && entry.id.startsWith(prefix) ? entry.id.slice(prefix.length) : '').filter(Boolean)); paint();
        } catch { if (owns() && ticket === generation) note.textContent += ' 本地目录读取失败；仍可手填模型 ID。'; }
      }
      connection.onchange = () => { edits++; return loadCatalog(); };
      candidates.onchange = () => { if (candidates.value) { model.value = candidates.value; edits++; paint(); } };
      model.oninput = () => { edits++; paint(); };
      const save = button('保存模型设置', async () => {
        if (!owns() || saving) return;
        const row = chosen(), value = model.value.trim();
        if (connection.value && (!row || row.credential?.status !== 'configured')) { status.textContent = '所选来源不可用或尚未配置 API Key，请先到模型来源检查。'; return; }
        if (row && (!value || row.models?.length && !row.models.includes(value))) { status.textContent = '请选择或填写来源范围内的物理模型 ID。'; return; }
        const revision = edits; saving = true; save.disabled = true;
        try {
          await client.action('quick_explain.configure', { config: { connection_id: connection.value || null, model: value || null } });
          if (!owns()) return;
          status.textContent = '共用模型设置已保存，仅新对话生效；没有发起模型调用。';
          if (revision !== edits) status.textContent += ' 保留你随后输入的未保存修改。';
        } catch (error) { if (owns()) status.textContent = `保存失败：${error.message}；未保存输入保留。`; }
        finally { saving = false; if (owns()) save.disabled = false; }
      }); save.type = 'button';
      const sources = el('a', '管理模型来源'); sources.href = '/#model-sources'; sources.target = '_blank'; sources.rel = 'noopener';
      const host = el('span', undefined, 'help-host'); host.setAttribute('data-help', '正在保存所有项目共用的设备模型设置；保存不会调用模型。'); host.append(save);
      const selection = el('fieldset', undefined, 'agent-connection-binding'), sourceField = label('模型来源', connection); sourceField.className = 'model-source-field';
      const actions = el('div', undefined, 'model-source-actions'); actions.append(sources);
      selection.append(el('legend', '模型来源与模型'), sourceField, choice.node, el('span', '选择候选会填入模型名称；也可直接输入物理模型 ID，保存时以名称输入框为准。', 'settings-note'), actions, note);
      const form = el('form', undefined, 'quick-chat-form'); form.append(selection, host, status); form.onsubmit = event => { event.preventDefault(); return save.onclick(); };
      settings.replaceChildren(scopeSummary(config), form); await loadCatalog();
    } catch (error) { if (owns()) settings.replaceChildren(el('p', `配置读取失败：${error.message}`, 'error'), button('重试读取配置', load, 'ghost')); }
    finally { pending = null; } })();
    return pending;
  }
  return load();
}
