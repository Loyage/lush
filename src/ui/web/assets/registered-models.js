import { button, el } from './dom.js';
import { confirmDialog } from './dialog.js';
import { registeredModelReason } from './agent-connection-picker.js';
import { diagnosticsLink } from './diagnostics-route.js';

const option = (id, text) => { const node = el('option', text); node.value = id; return node; };
const field = (label, control) => { const node = el('label', undefined, 'registered-model-field'); node.append(el('span', label), control); return node; };
const helpHost = (control, help) => { const host = el('span', undefined, 'help-host'); host.setAttribute('data-help', help); host.append(control); return host; };
const sourceReady = row => row.enabled && (row.credential?.status === 'configured'
  || (row.provider === 'openai-codex' && row.auth_type === 'oauth' && row.credential?.status === 'expired'));

/** Local device model index. A batch keeps acknowledged rows, so retry never resends successes. */
export function createRegisteredModels({ client, ownsPage, openSources }) {
  const node = el('section', undefined, 'registered-models');
  const toolbar = el('div', undefined, 'model-source-actions');
  const feedback = el('p', '正在读取已注册模型…', 'settings-note'); feedback.setAttribute('role', 'status');
  const rows = el('div', undefined, 'registered-model-rows');
  const editor = el('section', undefined, 'registered-model-editor'); editor.hidden = true;
  const add = button('注册模型', () => openEditor(), 'primary'); add.dataset.registerModel = 'add'; add.disabled = true;
  const reload = button('读取列表', load, 'ghost');
  toolbar.append(helpHost(add, '读取列表后可注册模型；设备最多 50 条，达到上限须先删除不需要的登记，保存期间不可重复操作。'), reload);
  node.append(toolbar, feedback, rows, editor);
  let models = [], sources = [], loaded = false, listRevision = 0, editorRevision = 0, lifecycle = 0, disposed = false, busy = false;
  const current = () => !disposed && ownsPage();
  const message = text => { if (current()) feedback.textContent = text; };
  function paint() {
    rows.replaceChildren();
    if (!models.length) {
      const empty = el('div', undefined, 'registered-model-empty');
      empty.append(el('p', '尚无已注册模型。先添加来源并登录（API 来源配置密钥），再从来源模型列表注册并命名。旧来源不会自动导入。'),
        button('添加来源或登录', () => openSources(), 'ghost'));
      rows.append(empty);
    }
    for (const row of models) {
      const item = el('article', undefined, 'registered-model-row'); item.dataset.registeredId = row.id;
      const copy = el('div', undefined, 'registered-model-copy');
      copy.append(el('strong', row.name), el('span', `来源：${row.source?.label || row.connection_id}`), el('span', `具体模型：${row.model}`));
      const reason = registeredModelReason(row); if (reason) copy.append(el('span', reason, 'agent-status-warning'));
      const actions = el('div', undefined, 'model-source-actions');
      actions.append(diagnosticsLink(el, { connection_id: row.connection_id, model: row.model }));
      const edit = button('编辑', () => openEditor(row), 'ghost'); edit.disabled = busy;
      const remove = button('删除', async () => {
        if (!current() || busy) return;
        if (!await confirmDialog({ title: `删除模型“${row.name}”？`, message: '仅删除登记，不删除来源、凭证或历史，也不更改已有运行配置的具体绑定。',
          confirmLabel: '删除登记', danger: true, confirmHelp: '删除后此名称不再可选；已有 Worker、默认配置和在途调用保持原具体绑定。' }) || !current() || busy) return;
        busy = true; add.disabled = true; paint();
        try {
          await client.action('agent.registered_models.remove', { id: row.id });
          ++listRevision; models = models.filter(item => item.id !== row.id);
          if (current()) { paint(); message(`已删除“${row.name}”；已有具体绑定不变。`); }
        } catch (error) { message(`删除失败：${error.message}`); }
        finally { busy = false; if (current()) { add.disabled = models.length >= 50; paint(); } }
      }, 'ghost', { help: '仅删除此模型登记；不删除来源、凭证或历史，不追改已有运行配置。' });
      remove.disabled = busy; actions.append(helpHost(edit, '编辑模型登记，不追改已有具体绑定；保存期间暂不可操作。'),
        helpHost(remove, '仅删除模型登记，不删除来源或已有具体绑定；保存期间暂不可操作。')); item.append(copy, actions); rows.append(item);
    }
    add.disabled = busy || !loaded || models.length >= 50;
  }
  async function load() {
    if (!current()) return;
    const stamp = ++listRevision;
    try {
      const [data, connections] = await Promise.all([client.read('/api/agent/registered-models'), client.read('/api/agent/connections')]);
      if (!current() || stamp !== listRevision) return;
      if (data?.version !== 1 || !Array.isArray(data.models) || !Array.isArray(connections?.connections)) throw new Error('数据格式不兼容');
      models = data.models; sources = connections.connections; loaded = true; paint();
      message(`已注册 ${models.length} / 50 个模型；只读取本地登记，未联网验证。`);
    } catch (error) { if (stamp === listRevision) message(`读取失败：${error.message}；已有列表与编辑保留。`); }
  }
  async function openEditor(existing = null) {
    if (!current() || busy || !loaded) return;
    if (!editor.hidden && !await confirmDialog({ title: '放弃当前登记草稿？', message: '已成功保存的项目不会撤销；仅放弃尚未保存的名称和选择。', confirmLabel: '放弃草稿', danger: true })) return;
    if (!current() || busy) return;
    const stamp = ++editorRevision;
    editor.hidden = false; editor.replaceChildren(el('h2', existing ? '编辑模型' : '注册模型'));
    const controls = el('fieldset', undefined, 'registered-model-controls');
    const source = el('select'); source.dataset.registeredSource = '';
    source.append(option('', '请选择已配置且已登录的来源'));
    for (const row of sources) {
      const item = option(row.id, `${row.label}${sourceReady(row) ? '' : '（请先启用并配置凭证 / 登录）'}`);
      item.disabled = !sourceReady(row); source.append(item);
    }
    if (existing && !sources.some(row => row.id === existing.connection_id)) source.append(option(existing.connection_id, `来源已删除：${existing.connection_id}`));
    source.value = existing?.connection_id || '';
    const catalogNote = el('p', '从一个来源多选具体模型，再逐项命名；保存仅登记，不改来源、不联网。', 'settings-note'); catalogNote.setAttribute('role', 'status');
    const choices = el('div', undefined, 'registered-model-choices');
    const results = el('p', '', 'settings-note'); results.setAttribute('role', 'status');
    let drafts = [], catalogRevision = 0, previousSource = source.value;
    const editName = el('input'); editName.value = existing?.name || ''; editName.maxLength = 128;
    editName.dataset.registeredName = 'edit';
    const editStatus = el('span', '', 'settings-note'); editStatus.setAttribute('role', 'status');
    const editModel = el('select'); editModel.dataset.registeredPhysical = '';
    if (existing) {
      controls.append(field('模型名称（设备内唯一）', editName), editStatus);
      const advanced = el('details'); advanced.append(el('summary', '高级：修改来源与具体模型'), field('来源', source), field('具体模型', editModel), catalogNote);
      controls.append(advanced, el('p', '更改登记不会追改已有具体绑定；运行设置需显式重新选择。', 'settings-note'));
    } else controls.append(field('来源', source), catalogNote, choices);
    const tools = el('div', undefined, 'model-source-actions');
    const manage = button('管理此来源 / 刷新目录', () => openSources(source.value), 'ghost');
    tools.append(manage);
    const save = button(existing ? '保存模型' : '保存所选模型', async () => {
      if (!current() || busy || stamp !== editorRevision) return;
      const pending = existing ? [{ name: editName, model: editModel.value, chosen: { checked: true }, status: editStatus }]
        : drafts.filter(row => row.chosen.checked && !row.saved);
      if (!pending.length) { results.textContent = '请选择至少一个尚未保存的模型。'; return; }
      const chosenSource = source.value, generation = lifecycle;
      if (!chosenSource) { results.textContent = '请先选择来源。'; return; }
      if (existing && !editModel.value) { results.textContent = '请先选择具体模型。'; return; }
      const counts = new Map();
      for (const draft of pending) { const name = draft.name.value.trim(); counts.set(name, (counts.get(name) || 0) + 1); }
      busy = true; controls.disabled = true; save.disabled = cancel.disabled = true; paint();
      let succeeded = 0, failed = 0;
      for (const draft of pending) {
        if (!current() || stamp !== editorRevision || generation !== lifecycle) break;
        const name = draft.name.value.trim();
        const collision = models.some(row => row.id !== existing?.id && (row.name === name || row.id === name));
        if (!name || new TextEncoder().encode(name).length > 128 || counts.get(name) > 1 || collision) {
          draft.status.textContent = !name ? '请填写名称。' : collision || counts.get(name) > 1 ? '名称冲突：请使用设备内唯一名称。' : '名称最多 128 UTF-8 字节。'; failed++; continue;
        }
        if (!existing && models.length >= 50) { draft.status.textContent = '已达到 50 条上限；请删除不需要的登记。'; failed++; continue; }
        draft.status.textContent = '保存中…';
        try {
          const saved = await client.action('agent.registered_models.save', { model: { ...(existing ? { id: existing.id } : {}), name, connection_id: chosenSource, model: draft.model } });
          // Record each ACK even if the user left during the request; never resend that item.
          ++listRevision; models = [...models.filter(row => row.id !== saved.id), saved]; draft.saved = true; succeeded++;
          draft.name.disabled = draft.chosen.disabled = true;
          draft.status.textContent = `已保存：${saved.name}`;
        } catch (error) { failed++; draft.status.textContent = `保存失败：${error.message}`; }
      }
      busy = false; controls.disabled = false; save.disabled = cancel.disabled = false;
      if (current() && stamp === editorRevision) {
        paint(); message(`已注册 ${models.length} / 50 个模型；已有运行配置的具体绑定不变。`);
        results.textContent = `本次成功 ${succeeded} 项，失败 ${failed} 项${generation !== lifecycle ? '，已停止其余未提交项' : ''}。成功项不会重发；可修改失败项后再次保存。`;
        if (existing && succeeded) { editor.hidden = true; message('模型已保存；已有具体绑定不变。'); }
        else if (drafts.length && drafts.every(row => !row.chosen.checked || row.saved)) save.disabled = true;
      }
    }, 'primary', { busyLabel: '保存中…' }); save.dataset.registeredSave = '';
    const cancel = button('关闭登记面板', () => { if (!busy) { ++editorRevision; editor.hidden = true; add.focus(); } }, 'ghost');
    tools.append(helpHost(save, '先选择具体模型并命名；保存期间或已无待保存项时不可重复提交。'), cancel); controls.append(tools); editor.append(controls, results);
    async function loadChoices() {
      const sequence = ++catalogRevision, generation = lifecycle, id = source.value, row = sources.find(row => row.id === id);
      choices.replaceChildren(); drafts = []; editModel.replaceChildren(); save.disabled = true; results.textContent = '';
      if (!row) { catalogNote.textContent = '请先添加来源、启用并配置凭证 / 登录。'; return; }
      catalogNote.textContent = '正在读取本地模型范围与目录缓存…';
      let cached = [], warning = '';
      try {
        const data = await client.read(`/api/agent/connections/models?id=${encodeURIComponent(id)}`);
        cached = ['fresh', 'cached'].includes(data.status) && Array.isArray(data.models) ? data.models : [];
      } catch (error) { warning = `目录读取失败：${error.message}；仍显示已填写范围。`; }
      if (!current() || generation !== lifecycle || stamp !== editorRevision || sequence !== catalogRevision || source.value !== id) return;
      const candidates = row.models?.length ? row.models.map(model => `${row.provider}/${model}`) : cached.map(model => model.id).filter(model => model.startsWith(`${row.provider}/`));
      const ids = [...new Set(candidates)];
      catalogNote.textContent = `${warning}${ids.length ? '只读本地模型范围 / 缓存，未联网验证。' : '暂无候选；请到此来源补充模型范围，或显式刷新目录后重新打开登记面板。'}`;
      if (existing) {
        editModel.append(option('', '请选择具体模型'), ...ids.map(id => option(id, id)));
        if (id === existing.connection_id && !ids.includes(existing.model)) editModel.append(option(existing.model, `${existing.model}（当前绑定）`));
        editModel.value = id === existing.connection_id ? existing.model : '';
      } else for (const model of ids) {
        const item = el('div', undefined, 'registered-model-candidate');
        const chosen = el('input'); chosen.type = 'checkbox'; chosen.dataset.registeredCandidate = model;
        const label = el('label', undefined, 'registered-model-check'); label.append(chosen, el('span', model));
        const name = el('input'); name.maxLength = 128; name.value = model.slice(row.provider.length + 1); name.disabled = true; name.dataset.registeredName = model;
        const status = el('span', '', 'settings-note'); status.setAttribute('role', 'status');
        const draft = { model, name, chosen, status, saved: false }; drafts.push(draft);
        chosen.onchange = () => { name.disabled = !chosen.checked || draft.saved; save.disabled = false; };
        name.oninput = () => { status.textContent = ''; save.disabled = false; };
        item.append(label, field('模型名称（设备内唯一）', name), status); choices.append(item);
      }
      save.disabled = !ids.length && !existing;
    }
    source.onchange = async () => {
      const next = source.value;
      if (drafts.some(row => row.chosen.checked && !row.saved) && !await confirmDialog({ title: '切换注册来源？',
        message: '当前来源尚未保存的选择和名称将被丢弃；已经成功保存的登记保留。', confirmLabel: '切换来源', danger: true })) {
        source.value = previousSource; return;
      }
      if (!current() || stamp !== editorRevision) return;
      previousSource = next; source.value = next; await loadChoices();
    };
    if (existing) await loadChoices();
    if (current() && stamp === editorRevision) (existing ? editName : source).focus();
  }
  return { node, load, dispose() { disposed = true; ++listRevision; ++lifecycle; }, resume() { disposed = false; } };
}
