import { $, el, button } from './dom.js';
import { api } from './api.js';
import { ui } from './state.js';
import { activateDetailView } from './sidebar-ui.js';
import { openQuickExplanation, explanationLocation } from './quick-explanation.js';

const PROVIDERS = new Set(['openai-compatible', 'deepseek', 'openrouter', 'zai']);
const option = (value, label) => { const node = el('option', label); node.value = value; return node; };
const field = (tag, name) => { const node = el(tag); node.dataset.quickField = name; return node; };
const label = (text, control) => { const node = el('label'); node.append(el('span', text), control); return node; };
const post = config => api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ method: 'quick_explain.configure', params: { config } }) });

/** A project-local page. Entry and history refresh only read local configuration/cache. */
export async function openQuickExplanationPage() {
  const view = activateDetailView({ view: 'quick-explain' });
  if (ui.quickExplanationPage?.view === view) return ui.quickExplanationPage.pending;
  const state = { view, historyGeneration: 0, pending: null };
  ui.quickExplanationPage = state;
  const owns = () => ui.view === view && ui.quickExplanationPage === state;
  const root = el('div', undefined, 'quick-explanation-page');
  root.append(el('h1', '快捷解释'), el('p', '在任意项目页面划选文字，右键选择“解释”。只将所选文字与页面位置发送给所选 API，不创建 Worker。配置和历史保存在当前项目。', 'hint'));
  const settings = el('section', undefined, 'quick-explanation-settings'), history = el('section', undefined, 'quick-explanation-history');
  root.append(settings, history); $('detail').replaceChildren(root);
  const note = el('p', '正在读取配置…', 'hint'); settings.append(el('h2', '解释设置'), note);
  const rows = el('div', undefined, 'quick-explanation-history-rows'), historyNote = el('p', '', 'hint');
  let before = null, reading = false;
  const more = button('加载更早解释', () => loadHistory(true), 'ghost'); more.hidden = true;
  const reload = button('刷新历史', () => loadHistory(false), 'ghost');
  history.append(el('h2', '历史解释'), el('p', '当前项目的所有页面记录；结果与来源保存当时快照，不随配置变化改写。', 'hint'), reload, historyNote, rows, more);
  async function loadHistory(append) {
    if (!owns() || (append && reading)) return;
    const version = ++state.historyGeneration; reading = true; more.disabled = true;
    historyNote.textContent = '正在读取历史…';
    try {
      const data = await api(`/api/quick-explain/history?limit=30${append && before ? `&before=${before}` : ''}`);
      if (!owns() || version !== state.historyGeneration) return;
      if (!append) rows.replaceChildren();
      for (const record of data.explanations || []) {
        const row = el('article', undefined, 'quick-explanation-history-row');
        const status = { completed: '已完成', running: '解释中', failed: '失败' }[record.status] || record.status;
        row.append(button(`#${record.id} · ${status} · ${record.quote}`, () => openQuickExplanation(record.id), 'quick-explanation-history-open'),
          el('p', `${record.source?.label || '来源快照见详情'} · ${record.model || '模型未知'} · ${explanationLocation(record.location)} · ${record.created_at || ''}`, 'hint'));
        rows.append(row);
      }
      before = data.next; more.hidden = !data.has_more;
      historyNote.textContent = rows.children.length ? '点击记录查看完整原文、解释结果和调用配置。' : '还没有解释记录。选中文字后右键选择“解释”。';
    } catch (error) { if (owns() && version === state.historyGeneration) historyNote.textContent = `历史读取失败：${error.message}；可刷新重试，已加载记录保留。`; }
    finally { if (owns() && version === state.historyGeneration) { reading = false; more.disabled = false; } }
  }
  async function loadSettings() {
    try {
      const [config, data] = await Promise.all([api('/api/quick-explain/config'), api('/api/agent/connections')]);
      if (!owns()) return;
      const entries = (data.connections || []).filter(row => row.enabled && row.auth_type === 'api_key' && PROVIDERS.has(row.provider));
      const connection = field('select', 'connection_id'), model = field('input', 'model'), candidates = field('select', 'model_choice'), prompt = field('textarea', 'prompt');
      connection.append(option('', '请选择模型来源'));
      for (const row of entries) connection.append(option(row.id, `${row.label} · ${row.provider}${row.credential?.status === 'configured' ? '' : '（凭证未就绪）'}`));
      if (config.connection_id && !entries.some(row => row.id === config.connection_id)) connection.append(option(config.connection_id, '已配置来源不可用，请重新选择'));
      connection.value = config.connection_id || ''; model.value = config.model || ''; model.placeholder = '物理模型 ID，例如 deepseek-chat';
      prompt.value = config.prompt || config.default_prompt || ''; prompt.rows = 9; prompt.maxLength = 8192;
      const modelNote = el('p', '', 'hint'), status = el('p', config.ready ? '本地配置就绪；不代表 API 已联网验证。' : config.reason || '请选择来源和模型后保存。', 'hint');
      const catalogue = new Map(); let catalogVersion = 0, saving = false, editRevision = 0;
      const chosen = () => entries.find(row => row.id === connection.value);
      const markEdited = () => { editRevision++; };
      function paintModels() {
        const row = chosen();
        const cached = catalogue.get(row?.id) || [];
        const models = row?.models?.length ? row.models : cached;
        candidates.replaceChildren(option('', models.length ? '选择此来源的模型…' : '无缓存候选，可手填模型 ID'));
        for (const value of [...new Set(models)]) candidates.append(option(value, value));
        candidates.value = ''; candidates.disabled = !models.length;
        modelNote.textContent = row ? `${row.label} · ${row.endpoint}。模型为物理 ID，不带 ${row.provider}/ 前缀；来源或候选变化不会替换当前输入。${row.models?.length && model.value && !row.models.includes(model.value.trim()) ? ' 当前模型不在来源范围内，请修正后保存。' : ''}` : '首版支持 OpenAI 兼容 Chat Completions API Key 来源，不支持 Codex OAuth 或 Kimi Coding 协议。';
      }
      async function loadCatalog() {
        paintModels(); const row = chosen(), version = ++catalogVersion;
        if (!row || row.models?.length || catalogue.has(row.id)) return;
        try {
          const cached = await api(`/api/agent/connections/models?id=${encodeURIComponent(row.id)}`);
          if (!owns() || version !== catalogVersion) return;
          const prefix = `${row.provider}/`;
          catalogue.set(row.id, (cached.models || []).map(entry => typeof entry.id === 'string' && entry.id.startsWith(prefix) ? entry.id.slice(prefix.length) : '').filter(Boolean));
          paintModels();
        } catch { if (owns() && version === catalogVersion) modelNote.textContent += ' 本地目录读取失败；仍可手填模型 ID。'; }
      }
      connection.onchange = () => { markEdited(); void loadCatalog(); };
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
          const result = await post({ connection_id: connection.value || null, model: value || null, prompt: prompt.value || null });
          if (!owns()) return;
          status.textContent = '已保存，下次解释生效；没有发起模型调用。';
          if (revision === editRevision) prompt.value = result.prompt || result.default_prompt || '';
        } catch (error) { if (owns()) status.textContent = `保存失败：${error.message}；未保存输入保留。`; }
        finally { saving = false; if (owns()) save.disabled = false; }
      }); save.type = 'button';
      const reset = button('恢复默认 Prompt', () => { prompt.value = config.default_prompt || ''; markEdited(); status.textContent = '已填入默认 Prompt，保存后生效。'; }, 'ghost'); reset.type = 'button';
      const sources = el('a', '管理模型来源'); sources.href = '#model-sources';
      const saveHost = el('span', undefined, 'help-host'); saveHost.setAttribute('data-help', '正在保存解释设置；保存不会调用模型。'); saveHost.append(save);
      form.onsubmit = event => { event.preventDefault(); return save.onclick(); };
      form.append(label('模型来源', connection), sources, label('模型 ID', model), label('来源内的候选模型', candidates), modelNote,
        label('解释 Prompt', prompt), el('p', '可调整解释风格、长度和语言。只读安全规则始终生效，选区里的命令不会被执行。空 Prompt 恢复默认；保存不调用模型。', 'hint'), reset, saveHost, status);
      settings.replaceChildren(el('h2', '解释设置'), form); await loadCatalog();
    } catch (error) {
      if (owns()) settings.replaceChildren(el('h2', '解释设置'), el('p', `配置读取失败：${error.message}`, 'error'), button('重试读取配置', loadSettings, 'ghost'));
    }
  }
  state.pending = Promise.all([loadSettings(), loadHistory(false)]);
  await state.pending;
}
