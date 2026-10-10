import { $, el, button } from './dom.js';
import { api } from './api.js';
import { ui } from './state.js';
import { activateDetailView } from './sidebar-ui.js';
import { confirmDialog } from './dialog.js';
import { openQuickExplanation, explanationLocation } from './quick-explanation.js';
import { settingsClient } from './settings-api.js';
import { scopeSummary, scopeImpact } from './settings-scope.js';
import { projectRoute } from './route.js';
import { workbenchStatus } from './project-picker.js';
import { createModelChoice } from './model-choice.js';

const PROVIDERS = new Set(['openai-compatible', 'deepseek', 'openrouter', 'zai']);
const option = (value, label) => { const node = el('option', label); node.value = value; return node; };
const field = (tag, name) => { const node = el(tag); node.dataset.quickField = name; return node; };
const label = (text, control) => { const node = el('label'); node.append(el('span', text), control); return node; };

/** Global page: device configuration only, never a model call or a project history read. */
export function openQuickExplanationPage() {
  const view = activateDetailView({ view: 'quick-explain' });
  if (ui.quickExplanationPage?.view === view) return ui.quickExplanationPage.pending;
  const state = { view, pending: null };
  ui.quickExplanationPage = state;
  const owns = () => ui.view === view && ui.quickExplanationPage === state;
  const client = settingsClient(), root = el('div', undefined, 'quick-explanation-page');
  root.append(el('h1', '快捷解释配置'), el('p', `${scopeImpact()} 只将项目页面的所选文字与位置发送给明确配置的 API，不创建 Worker。此页只编辑配置，不调用模型或读取项目历史。`, 'hint'));
  const settings = el('section', undefined, 'quick-explanation-settings');
  root.append(settings, el('p', '解释结果与追问保存在调用所属项目；请在项目工作页打开“快捷解释历史”。', 'hint'));
  $('detail').replaceChildren(root);
  function loadSettings() {
    if (!owns()) return Promise.resolve(); if (state.pending) return state.pending;
    settings.replaceChildren(el('h2', '解释设置'), el('p', '正在读取设备配置…', 'hint'));
    const loading = (async () => { try {
      const [config, data] = await Promise.all([client.read('/api/quick-explain/config'), client.read('/api/agent/connections')]);
      if (!owns()) return;
      const entries = (data.connections || []).filter(row => row.enabled && row.auth_type === 'api_key' && PROVIDERS.has(row.provider));
      const connection = field('select', 'connection_id'), model = field('input', 'model'), candidates = field('select', 'model_choice'), prompt = field('textarea', 'prompt');
      const modelChoice = createModelChoice({ model, candidates });
      connection.append(option('', '请选择模型来源'));
      for (const row of entries) connection.append(option(row.id, `${row.label} · ${row.provider}${row.credential?.status === 'configured' ? '' : '（凭证未就绪）'}`));
      if (config.connection_id && !entries.some(row => row.id === config.connection_id)) connection.append(option(config.connection_id, '已配置来源不可用，请重新选择'));
      connection.value = config.connection_id || ''; model.value = config.model || ''; model.placeholder = '物理模型 ID，例如 deepseek-chat';
      prompt.value = config.prompt || config.default_prompt || ''; prompt.rows = 9; prompt.maxLength = 8192;
      const modelNote = el('p', '', 'hint'), status = el('p', config.ready ? '本地配置就绪；不代表 API 已联网验证。' : config.reason || '请选择来源和模型后保存。', 'hint'); status.setAttribute('role', 'status');
      const catalogue = new Map(); let catalogVersion = 0, saving = false, editRevision = 0;
      const chosen = () => entries.find(row => row.id === connection.value);
      const markEdited = () => { editRevision++; };
      function paintModels() {
        const row = chosen(), cached = catalogue.get(row?.id) || [];
        const models = row?.models?.length ? row.models : cached;
        candidates.replaceChildren(option('', models.length ? '选择此来源的模型…' : '无缓存候选，可手填模型 ID'));
        for (const value of [...new Set(models)]) candidates.append(option(value, value));
        candidates.disabled = !models.length; modelChoice.sync();
        modelNote.textContent = row ? `${row.label} · ${row.endpoint}。模型为物理 ID，不带 ${row.provider}/ 前缀；来源或候选变化不会替换当前输入。${row.models?.length && model.value && !row.models.includes(model.value.trim()) ? ' 当前模型不在来源范围内，请修正后保存。' : ''}` : '首版支持 OpenAI 兼容 Chat Completions API Key 来源，不支持 Codex OAuth 或 Kimi Coding 协议。';
      }
      async function loadCatalog() {
        paintModels(); const row = chosen(), version = ++catalogVersion;
        if (!row || row.models?.length || catalogue.has(row.id)) return;
        try {
          const cached = await client.read(`/api/agent/connections/models?id=${encodeURIComponent(row.id)}`);
          if (!owns() || version !== catalogVersion) return;
          const prefix = `${row.provider}/`;
          catalogue.set(row.id, (cached.models || []).map(entry => typeof entry.id === 'string' && entry.id.startsWith(prefix) ? entry.id.slice(prefix.length) : '').filter(Boolean));
          paintModels();
        } catch { if (owns() && version === catalogVersion) modelNote.textContent += ' 本地目录读取失败；仍可手填模型 ID。'; }
      }
      connection.onchange = () => { markEdited(); return loadCatalog(); };
      candidates.onchange = () => { if (candidates.value) { model.value = candidates.value; markEdited(); paintModels(); } };
      model.oninput = () => { markEdited(); paintModels(); }; prompt.oninput = markEdited;
      const form = el('form', undefined, 'quick-explanation-form');
      const save = button('保存解释设置', async () => {
        if (!owns() || saving) return;
        const row = chosen(), value = model.value.trim();
        if (connection.value && (!row || row.credential?.status !== 'configured')) { status.textContent = '所选来源不可用或尚未配置 API Key，请先到模型来源检查。'; return; }
        if (row && (!value || (row.models?.length && !row.models.includes(value)))) { status.textContent = '请选择或填写来源范围内的物理模型 ID。'; return; }
        if (prompt.value.length > 8192) { status.textContent = 'Prompt 最多 8192 字。'; return; }
        saving = true; save.disabled = true; const revision = editRevision;
        try {
          const result = await client.action('quick_explain.configure', { config: { connection_id: connection.value || null, model: value || null, prompt: prompt.value || null } });
          if (!owns()) return;
          status.textContent = '设备解释设置已保存，下次解释生效；没有发起模型调用。';
          if (revision === editRevision) prompt.value = result.prompt || result.default_prompt || '';
          else status.textContent += ' 保留你随后输入的未保存修改。';
        } catch (error) { if (owns()) status.textContent = `保存失败：${error.message}；未保存输入保留。`; }
        finally { saving = false; save.disabled = false; }
      }); save.type = 'button';
      const reset = button('恢复默认 Prompt', () => { prompt.value = config.default_prompt || ''; markEdited(); status.textContent = '已填入默认 Prompt，保存后生效。'; }, 'ghost'); reset.type = 'button';
      const sources = el('a', '管理模型来源'); sources.href = '/#model-sources';
      const saveHost = el('span', undefined, 'help-host'); saveHost.setAttribute('data-help', '正在保存设备解释设置；保存不会调用模型。'); saveHost.append(save);
      form.onsubmit = event => { event.preventDefault(); return save.onclick(); };
      const selection = el('fieldset', undefined, 'agent-connection-binding');
      const sourceField = label('模型来源', connection); sourceField.className = 'model-source-field';
      const actions = el('div', undefined, 'model-source-actions'); actions.append(sources);
      selection.append(el('legend', '模型来源与模型'), sourceField, modelChoice.node,
        el('span', '选择候选会填入模型名称；也可直接输入物理模型 ID，保存时以名称输入框为准。', 'settings-note'), actions, modelNote);
      form.append(selection, label('解释 Prompt', prompt), el('p', '可调整解释风格、长度和语言。只读安全规则始终生效，选区里的命令不会被执行。空 Prompt 恢复默认；保存不调用模型。', 'hint'), reset, saveHost, status);
      settings.replaceChildren(el('h2', '解释设置'), scopeSummary(config), form); await loadCatalog();
    } catch (error) {
      if (owns()) settings.replaceChildren(el('h2', '解释设置'), el('p', `配置读取失败：${error.message}`, 'error'), button('重试读取配置', loadSettings, 'ghost'));
    } finally { state.pending = null; } })();
    state.pending = loading; return loading;
  }
  return loadSettings();
}

/** Project-only history; the fixed route guards delayed reads, deletes and record opens. */
export function openQuickExplanationHistory() {
  const project = projectRoute(), view = activateDetailView({ view: 'quick-explain-history', title: '快捷解释历史', context: '当前项目', hash: '#quick-explain-history' });
  if (ui.quickExplanationPage?.view === view) return ui.quickExplanationPage.pending;
  const state = { view, project, generation: 0, pending: null }; ui.quickExplanationPage = state;
  const owns = () => ui.view === view && ui.quickExplanationPage === state && projectRoute() === project;
  const root = el('div', undefined, 'quick-explanation-page'), history = el('section', undefined, 'quick-explanation-history');
  const settings = el('a', '打开设备快捷解释设置'); settings.href = '/#quick-explain'; settings.target = '_blank'; settings.rel = 'noopener';
  root.append(el('h1', '快捷解释历史'), settings, history); $('detail').replaceChildren(root);
  if (!project || !workbenchStatus().projectUsable) {
    history.append(el('p', '当前没有可用项目。历史属于来源项目；请在项目工作页打开，不创建全局历史。', 'hint')); return Promise.resolve();
  }
  const rows = el('div', undefined, 'quick-explanation-history-rows'), note = el('p', '', 'hint'); note.setAttribute('role', 'status');
  let before = null, reading = false;
  const more = button('加载更早解释', () => loadHistory(true), 'ghost'); more.hidden = true;
  const reload = button('刷新历史', () => loadHistory(false), 'ghost');
  history.append(el('p', '当前项目的所有页面记录；结果、来源与追问按当时快照保存，不随设备配置变化改写。', 'hint'), reload, note, rows, more);
  async function loadHistory(append) {
    if (!owns() || (append && reading)) return;
    const version = ++state.generation; reading = true; more.disabled = true; note.textContent = '正在读取历史…';
    try {
      const data = await api(`/api/quick-explain/history?limit=30${append && before ? `&before=${before}` : ''}`);
      if (!owns() || version !== state.generation) return;
      if (!append) rows.replaceChildren();
      for (const record of data.explanations || []) {
        const article = el('article', undefined, 'quick-explanation-history-row');
        const status = { completed: '已完成', running: '解释中', failed: '失败' }[record.status] || record.status;
        article.append(button(`#${record.id} · ${status} · ${record.quote}`, () => owns() ? openQuickExplanation(record.id) : undefined, 'quick-explanation-history-open'),
          el('p', `${record.source?.label || '来源快照见详情'} · ${record.model || '模型未知'} · ${explanationLocation(record.location)}${record.followup_count ? ` · 追问 ${record.followup_count} 轮` : ''} · ${record.created_at || ''}`, 'hint'));
        if (record.status === 'running') {
          const blocked = button('删除', () => {}, 'ghost danger'); blocked.disabled = true;
          const host = el('span', undefined, 'help-host'); host.setAttribute('data-help', '这次解释仍在进行，结束后才能删除；删除只移除历史记录，不会取消调用。'); host.append(blocked); article.append(host);
        } else article.append(button('删除', () => removeHistory(record, article), 'ghost danger', { help: '永久删除这条解释历史及全部追问、结果与来源快照；设备配置和其他记录保留。' }));
        rows.append(article);
      }
      before = data.next; more.hidden = !data.has_more;
      note.textContent = rows.children.length ? '点击记录查看完整原文、解释结果和调用配置。' : '还没有解释记录。选中文字后右键选择“解释”。';
    } catch (error) { if (owns() && version === state.generation) note.textContent = `历史读取失败：${error.message}；可刷新重试，已加载记录保留。`; }
    finally { if (owns() && version === state.generation) { reading = false; more.disabled = false; } }
  }
  async function removeHistory(record, article) {
    if (!owns()) return;
    const confirmed = await confirmDialog({ title: `删除解释 #${record.id}？`,
      message: '将永久删除这条解释历史记录及其全部追问问答；选区、结果和当时的来源与 Prompt 快照都无法恢复，设备解释设置和其他记录不受影响。',
      detail: record.quote, confirmLabel: '删除', cancelLabel: '保留', danger: true,
      confirmHelp: '永久删除来源项目的这条解释及追问，不删除设备模型配置，也不取消正在进行的调用。' });
    if (!confirmed || !owns()) return;
    try {
      await api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'quick_explain.delete', params: { id: record.id } }) });
      if (!owns()) return;
      article.remove(); note.textContent = rows.children.length ? `已删除解释 #${record.id}。` : '还没有解释记录。选中文字后右键选择“解释”。';
    } catch (error) { if (owns()) note.textContent = `删除失败：${error.message}；记录保留。`; }
  }
  state.pending = loadHistory(false); return state.pending;
}
