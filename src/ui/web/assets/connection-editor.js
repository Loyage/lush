import { block, button, el } from './dom.js';
import { PI_THINKING_LEVELS } from './agent-config-mode.js';
import { PROVIDERS, array, field, select, note, helped } from './connection-view-common.js';
import { createConnectionLogin } from './connection-login.js';

/** Owns public session drafts; password fields are cleared even when detached or writes fail. */
export function createConnectionEditor({ node, panel, operations, selection, selectConnection, now, setTimer, clearTimer }) {
  const { current, post, load, autoRefresh, message } = operations;
  const editor = block('添加连接'), editorHost = el('div'); editor.append(editorHost); editor.hidden = true;
  const drafts = new Map();
  let dirty = false, editId = null, editorRevision = 0, saving = false;
  const fieldInEditor = key => editorHost.querySelector(`[data-connection-field="${key}"]`);
  const login = createConnectionLogin({ node, editorHost, current, post, load, autoRefresh, message,
    invalidateList: operations.invalidateList, selectConnection, back: panel.back, now, setTimer, clearTimer,
    editor: { revision: () => editorRevision, close: closeEditor, showLogin(id, title) {
      panel.open('editor'); dirty = false; editId = id; editorRevision++; editor.querySelector('h2').textContent = title;
    } } });
  function retainDraft() {
    if (dirty && fieldInEditor('label')) {
      const draft = {};
      for (const input of [...editorHost.querySelectorAll('input'), ...editorHost.querySelectorAll('select')]) {
        if (input.type !== 'password') draft[input.dataset.connectionField] = input.type === 'checkbox' ? input.checked : input.value;
      }
      drafts.set(editId || '', draft);
    }
  }
  function closeEditor() {
    retainDraft(); login.invalidate();
    // Public drafts survive navigation, secrets never do (including detached inputs).
    for (const input of editorHost.querySelectorAll('input')) if (input.type === 'password') input.value = '';
    editor.hidden = true;
  }
  function paintEditor(connection = null, trigger = document.activeElement) {
    retainDraft(); login.invalidate();
    for (const input of editorHost.querySelectorAll('input')) if (input.type === 'password') input.value = '';
    editId = connection?.id || null; editorRevision++; dirty = false;
    panel.open('editor', trigger);
    editor.querySelector('h2').textContent = connection ? `编辑连接 · ${connection.label}` : '添加连接';
    const form = el('div', undefined, 'agent-connection-form');
    const label = field(form, '连接名称', 'label', 'text', connection?.label || ''); label.maxLength = 120;
    const provider = select(form, '服务商', 'provider', PROVIDERS, connection?.provider || 'deepseek');
    const endpoint = field(form, '模型端点（HTTPS，可留空）', 'endpoint', 'url', connection?.endpoint || '', '留空采用该服务商官方模型端点；代理密钥不能发往官方余额接口。'); endpoint.maxLength = 2048;
    const models = field(form, '模型列表（模型 ID，逗号分隔）', 'models', 'text', array(connection?.models).join(', '), '在此填写一次，保存后发射 Worker 即可从所选来源的列表选择，无需重复输入。填写物理模型 ID，不加服务商前缀；非空时也限制模型范围，留空不限制，不进行付费可用性探测。'); models.maxLength = 8192;
    const defaultModel = field(form, '默认模型（可选）', 'default_model', 'text', connection?.default_model || '', '填写物理模型 ID（可留空）；填写了模型列表时须在列表内。已有 Worker 主动换源时自动填入此模型，思考深度不变；其他运行设置可一键填入，不代表已验证可用。');
    defaultModel.maxLength = 256;
    const defaultModelList = el('datalist'); defaultModelList.id = 'connection-default-model-options';
    defaultModel.setAttribute('list', defaultModelList.id); defaultModel.parentNode.append(defaultModelList);
    const defaultThinking = select(form, '默认思考深度（可选）', 'default_thinking',
      [['', '不设置'], ...PI_THINKING_LEVELS.map(level => [level, level])], connection?.default_thinking || '');
    const enabled = field(form, '启用连接', 'enabled', 'checkbox', connection?.enabled ?? true);
    const notifyReset = field(form, '额度刷新提醒（页面内）', 'notify_reset', 'checkbox', connection?.notify_reset ?? false,
      '开启后，页面在缓存观测的重置时间到达时标出该额度；系统通知开关已开启且已授权时另发浏览器通知。不新增后台调度，关闭页面不补发提醒。');
    const credentialWrap = el('div', undefined, 'agent-connection-secret');
    const key = field(credentialWrap, 'API Key（仅写入，更换时才填写）', 'api_key', 'password', '', '留空保留已有密钥。提交后立即清空，不回显、不保存到浏览器。');
    key.autocomplete = 'new-password'; key.maxLength = 8192; key.setAttribute('spellcheck', 'false');
    const oauthNote = el('p', 'Codex 使用 OAuth：先保存连接，再点击卡片“登录 / 重新登录”。不接受手动录入 OAuth token。', 'hint');
    const compatibleNote = el('p', '自定义 API 必须填写 HTTPS 模型端点（通常含 /v1）和至少一个物理模型 ID；仅支持 OpenAI Chat Completions 协议，未联网验证可用性。当前按文本/工具调用配置，32K 上下文、4K 输出为本地运行预算，不代表上游实际限额。余额查询尚不支持，不代表余额为零。', 'hint');
    form.append(credentialWrap, oauthNote, compatibleNote);
    const localFeedback = el('p', undefined, 'hint agent-connection-editor-feedback'); localFeedback.setAttribute('role', 'status');
    const changed = () => { dirty = true; editorRevision++; login.invalidate(); };
    const rebuildDefaultModels = () => {
      const ids = models.value.split(/[,，\n]/).map(value => value.trim()).filter(Boolean);
      defaultModelList.replaceChildren(...ids.map(id => { const option = el('option'); option.value = id; return option; }));
    };
    rebuildDefaultModels();
    for (const input of [label, endpoint, models, key]) input.oninput = changed;
    models.oninput = () => { changed(); rebuildDefaultModels(); };
    enabled.onchange = notifyReset.onchange = defaultThinking.onchange = changed;
    defaultModel.oninput = changed;
    const syncAuth = () => {
      const oauth = provider.value === 'openai-codex', compatible = provider.value === 'openai-compatible';
      credentialWrap.hidden = oauth; oauthNote.hidden = !oauth; compatibleNote.hidden = !compatible;
      endpoint.required = models.required = compatible; key.value = '';
    };
    provider.onchange = () => { endpoint.value = ''; changed(); syncAuth(); updatePreview(); }; syncAuth();
    const preview = el('p', undefined, 'model-source-call-preview');
    note(form, '模型 ID 示例：gpt-6.1-sol（无需服务商前缀）。org/model 也可以是合法物理 ID，不会自动截断。');
    form.append(preview);
    const prefixHelp = helped('修正当前服务商前缀', () => {
      const prefix = `${provider.value}/`;
      models.value = models.value.split(/[,，\n]/).map(id => id.trim().startsWith(prefix) ? id.trim().slice(prefix.length) : id.trim()).join(', ');
      if (defaultModel.value.startsWith(prefix)) defaultModel.value = defaultModel.value.slice(prefix.length);
      changed(); rebuildDefaultModels(); updatePreview();
    }, '仅在你确认误输入当前服务商前缀时，移除该前缀一次；其他 slash 物理 ID 保留。'); form.append(prefixHelp);
    function updatePreview() {
      const ids = models.value.split(/[,，\n]/).map(id => id.trim()).filter(Boolean), model = defaultModel.value.trim() || ids[0] || 'gpt-6.1-sol';
      preview.textContent = `最终调用名预览：${provider.value}/${model}`;
      prefixHelp.hidden = ![...ids, defaultModel.value].some(id => id.startsWith(`${provider.value}/`));
    }
    models.oninput = () => { changed(); rebuildDefaultModels(); updatePreview(); };
    defaultModel.oninput = () => { changed(); updatePreview(); };
    const draft = drafts.get(editId || '');
    if (draft) {
      for (const input of [...form.querySelectorAll('input'), ...form.querySelectorAll('select')]) {
        const value = draft[input.dataset.connectionField];
        if (value !== undefined && input.type !== 'password') input.type === 'checkbox' ? input.checked = value : input.value = value;
      }
      dirty = true; syncAuth(); rebuildDefaultModels(); localFeedback.textContent = '已恢复本次会话的未保存公开草稿；秘密不保留。';
    }
    updatePreview();
    note(form, '保存 / 登录成功后：已启用且有本地凭证的受支持连接会自动联网刷新余额 / 套餐；不调用模型。保存成功与查询失败分别报告。自定义兼容 API 不查询。');
    const actions = el('div', undefined, 'agent-connection-actions');
    actions.append(button('保存连接', async () => {
      if (!current() || saving) return;
      if (operations.isBusy(editId)) { localFeedback.textContent = '此连接正在批量配置，草稿保留；请待批量结束后再保存。'; return; }
      let params;
      try {
        const name = label.value.trim(); if (!name) throw new Error('请填写连接名称。');
        const url = endpoint.value.trim();
        if (provider.value === 'openai-compatible' && !url) throw new Error('自定义兼容 API 必须填写 HTTPS 模型端点。');
        if (url) { const parsed = new URL(url); if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('模型端点必须是无凭证、无查询参数、无片段的 HTTPS 地址。'); }
        const ids = models.value.split(/[,，\n]/).map(value => value.trim()).filter(Boolean);
        if (provider.value === 'openai-compatible' && !ids.length) throw new Error('自定义兼容 API 必须填写至少一个物理模型 ID。');
        if (ids.length > 50 || new Set(ids).size !== ids.length || ids.some(id => id.length > 256)) throw new Error('模型 ID 不可重复，最多 50 个，每个最长 256 字符。');
        if (defaultModel.value.trim() && ids.length && !ids.includes(defaultModel.value.trim())) throw new Error('默认模型必须在上方的模型列表内。');
        const value = { ...(connection ? { id: connection.id } : {}), label: name, provider: provider.value, auth_type: provider.value === 'openai-codex' ? 'oauth' : 'api_key',
          enabled: enabled.checked, models: ids, default_model: defaultModel.value.trim(), default_thinking: defaultThinking.value,
          notify_reset: notifyReset.checked, ...(url ? { endpoint: url } : {}) };
        params = { connection: value, ...(value.auth_type === 'api_key' && key.value.trim() ? { credential: { api_key: key.value.trim() } } : {}) };
      } catch (error) { localFeedback.textContent = error instanceof TypeError ? '模型端点不是有效 HTTPS 地址。' : error.message; localFeedback.setAttribute('role', 'alert'); return; }
      // Only the request body briefly contains the secret. Clear the live input even when the write fails.
      key.value = ''; saving = true; operations.invalidateList(); const revision = editorRevision, selectionStamp = selection.revision(), generation = operations.generation();
      const savedEditId = editId;
      operations.beginSave(savedEditId);
      localFeedback.textContent = '正在保存连接…';
      try {
        const writing = post('agent.connections.save', params); delete params.credential;
        const saved = await writing; if (!current() || generation !== operations.generation()) return;
        if (revision === editorRevision) {
          dirty = false; drafts.delete(editId || ''); closeEditor();
          if (saved?.id) selection.saved(saved.id, selectionStamp);
          if (panel.kind() === 'editor') panel.back();
        }
        await load(true); message('连接已保存；不会自动改变运行中的 Worker 或原 CLI 登录。');
        const refreshed = await autoRefresh(saved?.id);
        if (current()) message(refreshed === false ? '连接已保存；自动查询失败或未知，旧值仅供参考（非零余额）。' : refreshed === true ? '连接已保存，资源已自动刷新。' : '连接已保存；此连接不触发自动资源查询。', refreshed === false);
      } catch { if (current() && generation === operations.generation()) { localFeedback.textContent = '保存连接失败；密钥输入已清空，请确认配置后重新提交。'; localFeedback.setAttribute('role', 'alert'); } }
      finally { saving = false; operations.endSave(savedEditId); }
    }), button('取消编辑', () => {
      if (current()) { dirty = false; drafts.delete(editId || ''); closeEditor(); panel.back(); }
    }, 'ghost'));
    editorHost.replaceChildren(form, localFeedback, actions);
    if (trigger !== null) label.focus();
  }
  return { node: editor, paint: paintEditor, close: closeEditor,
    editedId: () => editId, activeLoginId: login.activeId,
    beginDeviceLogin: login.beginDeviceLogin, beginLogin: login.beginLogin,
    invalidate() { editorRevision++; closeEditor(); }, invalidateLogin: login.invalidate };
}
