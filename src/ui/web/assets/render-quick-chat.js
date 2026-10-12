import { $, el, button } from './dom.js';
import { api } from './api.js';
import { ui } from './state.js';
import { activateDetailView } from './sidebar-ui.js';
import { modelHelp } from './help.js';
import { pageSubnav } from './page-subnav.js';
import { confirmDialog } from './dialog.js';
import { quickChatAction, quickChatConfig, chatHref, conversationHref, requireChatProject, chatReferences } from './quick-chat.js';
import { projectRoute } from './route.js';
import { pageModules } from './page-modules.js';
import { listEntry, listSurface } from './list-surface.js';
import { composerReferences, setComposerReferences } from './context-references.js';

const statusText = status => ({ running: '回复中', completed: '已完成', failed: '失败' }[status] || '状态未知');
const link = (text, href) => { const node = el('a', text, 'ghost'); node.href = href; return node; };
const field = (tag, name) => { const node = el(tag); node.dataset.chatField = name; return node; };
const label = (text, control) => { const node = el('label'); node.append(el('span', text), control); return node; };
function keyboard(input, send) {
  let composing = false;
  input.oncompositionstart = () => { composing = true; }; input.oncompositionend = () => { composing = false; };
  input.onkeydown = event => {
    if (composing || event.isComposing || event.keyCode === 229 || event.repeat || event.key !== 'Enter' || event.altKey) return;
    if (!event.metaKey && !event.ctrlKey && (event.shiftKey || window.matchMedia?.('(pointer: coarse)').matches)) return;
    event.preventDefault(); return send();
  };
}
function page(view, options = {}) {
  const project = requireChatProject();
  ui.disposeQuickChatPage?.();
  const identity = activateDetailView({ view, ...options }), owner = globalThis.document;
  const state = { identity, disposed: false, timer: null, controller: new AbortController() };
  ui.quickChatPage = state;
  const owns = () => !state.disposed && ui.quickChatPage === state && ui.view === identity && globalThis.document === owner && projectRoute() === project;
  ui.disposeQuickChatPage = () => {
    state.disposed = true; clearTimeout(state.timer); state.controller.abort(); ui.syncQuickChatReferences = null;
  };
  const root = el('div', undefined, 'quick-chat-page'); $('detail').replaceChildren(root);
  return { state, owns, root, read: path => api(path, { signal: state.controller.signal }) };
}
function selectedWithin(node) {
  const selection = window.getSelection?.(); if (!selection || selection.isCollapsed) return false;
  for (const endpoint of [selection.anchorNode, selection.focusNode]) {
    for (let current = endpoint; current; current = current.parentNode) if (current === node) return true;
  }
  return false;
}
function referencesView(values, removeReference = null) {
  const box = el('section', undefined, 'quick-chat-references'); box.hidden = values.length === 0;
  for (const reference of values) {
    const item = el('details'); item.append(el('summary', `${reference.label || '引用文字'}${reference.project_id ? ` · 项目 ${reference.project_id}` : ''}`),
      el('blockquote', reference.quote), el('p', JSON.stringify(reference.location || {}), 'hint'));
    if (removeReference) {
      const row = el('div'); row.append(item, button('移除引用', () => removeReference(reference), 'ghost',
        { help: '只从尚未发送的新对话中移除这项引用快照，不删除原内容或历史，不调用模型。' })); box.append(row);
    } else box.append(item);
  }
  return box;
}

function chatSubnav(current) {
  return pageSubnav('快速对话子页面', [
    { id: 'settings', label: '设置', href: chatHref('#quick-chat-settings') },
    { id: 'history', label: '历史记录', href: chatHref() },
  ], current);
}

export async function openQuickChatPage() {
  const { owns, root, read } = page('quick-chat');
  root.append(chatSubnav('history'), el('h1', '快速对话'), el('p', '纯文本记录、整理与交流，不创建 Worker、不执行工具。每段多轮对话保存为一条 C 编号历史。', 'hint'));
  const form = el('form', undefined, 'quick-chat-form'), prompt = field('select', 'prompt_id'), input = field('textarea', 'content');
  input.rows = 4; input.maxLength = 8192; input.placeholder = '想记录、整理或了解什么？也可以仅发送引用。';
  const refs = el('div'), note = el('p', '正在读取 Prompt…', 'hint'); note.setAttribute('role', 'status');
  let config = null, sending = false, edits = 0;
  const send = button('开始对话', submit, 'primary', { agent: true, help: modelHelp('使用所选 Prompt、正文与引用快照开始一段纯文本对话，保存在当前项目历史；不创建 Worker') });
  send.onclick = submit;
  const sendHost = el('span', undefined, 'help-host'); sendHost.setAttribute('data-help', modelHelp('等待配置就绪或当前请求结束；只直连模型，不调用 Agent')); sendHost.append(send);
  const sync = () => {
    if (!owns()) return;
    refs.replaceChildren(referencesView(composerReferences(), reference => {
      if (owns()) setComposerReferences(composerReferences().filter(value => value !== reference));
    }));
    send.disabled = sending || !config?.model?.ready || !prompt.value || (!input.value.trim() && !composerReferences().length);
  };
  ui.syncQuickChatReferences = sync;
  input.oninput = () => { edits++; sync(); }; prompt.onchange = () => { edits++; sync(); };
  keyboard(input, submit); form.onsubmit = event => { event.preventDefault(); return submit(); };
  form.append(label('Prompt', prompt), refs, label('内容', input), sendHost, note); root.append(form);
  async function submit() {
    if (!owns() || sending || send.disabled) return;
    const content = input.value, captured = composerReferences(), referenceRevision = ui.composerReferenceRevision, revision = edits, chosen = prompt.value;
    sending = true; sync();
    try {
      const record = await quickChatAction('start', { prompt_id: chosen, content: content.trim(), references: chatReferences(captured) });
      if (!owns()) return;
      const untouched = revision === edits && input.value === content && prompt.value === chosen && ui.composerReferenceRevision === referenceRevision;
      note.textContent = `对话 ${record.number} 已创建。`;
      if (untouched) { input.value = ''; setComposerReferences([]); return openQuickChatConversation(record.id); }
      const opened = link(`打开已创建的对话 ${record.number}（新标签）`, conversationHref(record.id)); opened.target = '_blank'; opened.rel = 'noopener'; root.append(opened);
      note.textContent += ' 你随后编辑的内容保留在此页，未发送；可点击链接查看已创建对话。';
    } catch (error) { if (owns()) note.textContent = `创建未确认：${error.message}；内容保留，请先核对历史，不要自动重发。`; }
    finally { sending = false; sync(); }
  }
  const history = el('section', undefined, 'quick-chat-history'), rows = el('div'), historyNote = el('p', '', 'hint');
  let before = null, loading = false, generation = 0;
  const more = button('加载更早对话', () => loadHistory(true), 'ghost'); more.hidden = true;
  const historyHeading = el('div', undefined, 'section-title'); historyHeading.append(el('h2', '对话历史'), button('刷新历史', () => loadHistory(false), 'ghost'));
  history.append(historyHeading, historyNote, rows, more); root.append(history);
  listSurface({ root, card: history, heading: historyHeading, body: rows });
  async function loadHistory(append) {
    if (!owns() || loading) return;
    const ticket = ++generation; loading = true; more.disabled = true;
    try {
      const data = await read(`/api/quick-chat/history?limit=30${append && before ? `&before=${before}` : ''}`);
      if (!owns() || ticket !== generation) return;
      if (!append) rows.replaceChildren();
      for (const record of data.conversations || []) {
        const item = listEntry(el('article', undefined, 'quick-chat-history-row'));
        item.append(link(`${record.number} · ${statusText(record.status)} · ${record.content || record.prompt_name || '引用对话'}`, conversationHref(record.id)),
          el('p', `${record.prompt_name || 'Prompt 未知'} · ${record.model || '模型未知'} · ${record.turn_count || 0} 轮 · ${record.created_at || ''}`, 'hint'));
        rows.append(item);
      }
      before = data.next; more.hidden = !data.has_more; historyNote.textContent = rows.children.length ? '历史按新到旧排列。点击编号继续同一段对话。' : '还没有对话记录。';
    } catch (error) { if (owns()) historyNote.textContent = `历史读取失败：${error.message}；已加载内容保留。`; }
    finally { loading = false; if (owns()) more.disabled = false; }
  }
  await Promise.all([loadHistory(false), (async () => {
    try {
      config = await quickChatConfig(); if (!owns()) return;
      for (const value of config.prompts || []) { const node = el('option', value.name); node.value = value.id; prompt.append(node); }
      prompt.value = config.prompts?.[0]?.id || '';
      note.textContent = config.model?.ready ? '选择 Prompt 本身不会调用模型。' : config.model?.reason || '请先配置模型来源。'; sync();
    } catch (error) { if (owns()) note.textContent = `配置读取失败：${error.message}；未发送内容保留。`; }
  })()]); sync();
}

export async function openQuickChatConversation(id) {
  const { state, owns, root, read } = page('quick-chat-conversation', { key: `quick-chat-C${id}`, title: `快速对话 C${id}`, hash: `#quick-chat-C${id}` });
  root.append(chatSubnav('history'), el('h1', `快速对话 C${id}`), link('全部对话 / 新对话', chatHref()));
  const metadata = el('section'), thread = el('div', undefined, 'quick-chat-thread'), note = el('p', '', 'hint'); note.setAttribute('role', 'status');
  const input = field('textarea', 'reply'); input.rows = 4; input.maxLength = 8192; input.placeholder = '继续这段纯文本对话';
  let record = null, sending = false, reading = false, edits = 0, readGeneration = 0, renderedSignature = null;
  const signature = () => JSON.stringify([record?.number, record?.status, record?.source, record?.model, record?.prompt, record?.references, record?.turns]);
  const send = button('发送', submit, 'primary', { agent: true, help: modelHelp('沿用本对话固定的模型与 Prompt 继续交流；不创建 Worker，不执行工具') });
  send.onclick = submit;
  const sendHost = el('span', undefined, 'help-host'); sendHost.setAttribute('data-help', modelHelp('当前轮结束后才能继续发送；沿用本对话的模型快照')); sendHost.append(send);
  const remove = button('删除对话', removeRecord, 'ghost danger', { help: '确认后永久删除这段对话及全部消息和引用快照；编号不复用，不删除其他历史或 Prompt。' });
  remove.onclick = removeRecord;
  const removeHost = el('span', undefined, 'help-host'); removeHost.setAttribute('data-help', '对话回复中不能删除，结束后可删除全部历史；不会取消模型调用。'); removeHost.append(remove);
  const sync = () => { send.disabled = sending || !record || record.status === 'running' || !input.value.trim(); remove.disabled = sending || !record || record.status === 'running'; };
  input.oninput = () => { edits++; sync(); }; keyboard(input, submit);
  const form = el('form', undefined, 'quick-chat-form'); form.append(label('继续对话', input), sendHost); form.onsubmit = event => { event.preventDefault(); return submit(); };
  root.append(metadata, thread, button('刷新对话', () => load(), 'ghost'), removeHost, form, note);
  function paint() {
    sync();
    const nextSignature = signature();
    if (renderedSignature === nextSignature || selectedWithin(metadata) || selectedWithin(thread)) return;
    renderedSignature = nextSignature;
    metadata.replaceChildren(el('p', `${record.number} · ${statusText(record.status)} · ${record.source?.label || '来源未知'} · ${record.model || '模型未知'}`, 'hint'));
    const snapshot = el('details'); snapshot.append(el('summary', `当时的 Prompt：${record.prompt?.name || '未知'}`), el('pre', record.prompt?.prompt || '无快照'));
    const source = el('details'); source.append(el('summary', '当时的模型来源'), el('p', `${record.source?.label || '未知'} · ${record.source?.provider || '协议未知'} · ${record.source?.endpoint || '端点未知'}`, 'hint'));
    metadata.append(snapshot, source, referencesView(record.references || []));
    thread.replaceChildren(...(record.turns || []).map(turn => {
      const item = el('article', undefined, 'quick-chat-turn');
      item.append(el('h2', '你', 'quick-chat-speaker'), el('p', turn.content || '（发送引用内容）', 'quick-chat-content'), el('h2', '模型', 'quick-chat-speaker'));
      item.append(el('p', turn.result || (turn.status === 'running' ? '正在回复…' : turn.error || '没有回复'), turn.status === 'failed' ? 'quick-chat-content error' : 'quick-chat-content'));
      if (turn.truncated) item.append(el('p', '本轮上下文超出预算，最早的历史问答未发送；本页仍保留完整记录。', 'hint'));
      return item;
    })); sync();
  }
  async function load() {
    if (!owns() || reading || sending) return; reading = true; const generation = readGeneration;
    try { const next = await read(`/api/quick-chat/${id}`); if (!owns() || generation !== readGeneration) return; record = next; paint(); note.textContent = record.status === 'running' ? '当前轮进行中，关闭页面不取消调用。' : record.status === 'failed' ? '本轮失败；已有消息保留，可以明确发送新消息继续。' : ''; }
    catch (error) { if (owns() && generation === readGeneration) note.textContent = `对话读取失败：${error.message}；可刷新重试。`; }
    finally { reading = false; clearTimeout(state.timer); if (owns() && !sending && (record?.status === 'running' || record && signature() !== renderedSignature)) state.timer = setTimeout(load, 1200); }
  }
  async function submit() {
    if (!owns() || sending || send.disabled) return;
    const value = input.value, revision = edits; sending = true; readGeneration++; clearTimeout(state.timer); sync();
    try {
      const next = await quickChatAction('send', { id, content: value.trim() });
      if (!owns()) return; record = next;
      if (revision === edits && input.value === value) input.value = '';
      paint(); note.textContent = '消息已保存，等待模型回复。'; if (record.status === 'running') { clearTimeout(state.timer); state.timer = setTimeout(load, 1200); }
    } catch (error) { if (owns()) note.textContent = `发送未确认：${error.message}；输入保留，请先刷新核对，不要自动重发。`; }
    finally { sending = false; if (owns()) sync(); }
  }
  async function removeRecord() {
    if (!owns() || sending || remove.disabled) return;
    const confirmed = await confirmDialog({ title: `删除对话 ${record.number}？`, message: '永久删除整段对话及全部轮次、结果、引用与来源快照。Prompt 设置和其他对话不受影响，编号不复用。', danger: true, confirmLabel: '删除', cancelLabel: '保留', confirmHelp: '永久删除这段纯文本历史，无法恢复；不会删除 Prompt 或取消正在进行的调用。' });
    if (!confirmed || !owns()) return;
    sending = true; sync();
    try { await quickChatAction('delete', { id }); if (owns()) return openQuickChatPage(); }
    catch (error) { if (owns()) note.textContent = `删除未确认：${error.message}；请刷新核对，不要自动重试。`; }
    finally { sending = false; if (owns()) sync(); }
  }
  sync(); await load();
}

export async function openQuickChatSettings() {
  const { owns, root } = page('quick-chat-settings');
  root.append(chatSubnav('settings'), el('h1', '快速对话设置'),
    el('p', 'Prompt 库与右键注册只属于当前项目，所有项目共用设备模型。保存不调用模型；注册到右键菜单后，点击该动作才发起纯文本对话。', 'hint'));
  const library = el('section', undefined, 'quick-chat-library'), models = el('section'); root.append(library, models);
  let config = null, saving = false, edits = 0;
  const picker = field('select', 'edit_prompt'), name = field('input', 'name'), body = field('textarea', 'prompt'), menu = field('input', 'context_menu');
  name.maxLength = 80; body.maxLength = 16384; body.rows = 7; menu.type = 'checkbox';
  const note = el('p', '正在读取 Prompt…', 'hint'); note.setAttribute('role', 'status');
  const save = button('保存 Prompt', savePrompt), remove = button('删除 Prompt', removePrompt, 'ghost danger', { help: '确认后移除这个自定义 Prompt，既有对话的 Prompt 快照仍保留；内置快速解释不能删除，可关闭右键注册。' });
  save.onclick = savePrompt; remove.onclick = removePrompt;
  const blocked = el('span', undefined, 'help-host'); blocked.setAttribute('data-help', '内置快速解释不能删除，可以取消“注册到右键菜单”；读取或保存期间不能删除。'); blocked.append(remove);
  const form = el('form', undefined, 'quick-chat-form'); form.append(label('编辑 Prompt', picker), label('名称', name), label('Prompt 正文', body), label('注册到右键菜单', menu), save, blocked, note);
  form.onsubmit = event => { event.preventDefault(); return savePrompt(); };
  const heading = el('div', undefined, 'section-title'); heading.append(el('h2', 'Prompt 库')); library.append(heading, form);
  const selected = () => config?.prompts?.find(value => value.id === picker.value);
  const sync = () => { save.disabled = saving || !config || !name.value.trim() || !body.value.trim(); remove.disabled = saving || !selected() || Boolean(selected()?.builtin); };
  function fill() { const value = selected(); name.value = value?.name || ''; body.value = value?.prompt || ''; menu.checked = value?.context_menu ?? false; edits++; sync(); }
  function paintConfig(preferred = picker.value) {
    picker.replaceChildren(); const fresh = el('option', '新建 Prompt'); fresh.value = ''; picker.append(fresh);
    for (const value of config.prompts || []) { const node = el('option', `${value.name}${value.builtin ? '（内置示例）' : ''}${value.context_menu ? ' · 已注册右键' : ' · 仅保存'}`); node.value = value.id; picker.append(node); }
    picker.value = config.prompts.some(value => value.id === preferred) ? preferred : ''; fill();
  }
  picker.onchange = fill; name.oninput = body.oninput = () => { edits++; sync(); }; menu.onchange = () => { edits++; sync(); };
  async function reload() {
    const revision = edits;
    try {
      const next = await quickChatConfig(); if (!owns()) return; config = next;
      if (revision === edits) { paintConfig(); note.textContent = '修改使用版本校验；配置冲突时先复制修改，再重新读取。'; }
      else note.textContent = '已更新 Prompt 库版本；保留读取期间的选择和未保存修改，没有调用模型。';
    } catch (error) { if (owns()) note.textContent = `读取失败：${error.message}；已有输入保留。`; }
    sync();
  }
  library.append(button('重新读取 Prompt 库', async () => {
    if (saving) return;
    if (name.value.trim() || body.value.trim()) {
      const confirmed = await confirmDialog({ title: '重新读取 Prompt？', message: '会替换当前编辑表单。请先复制未保存修改；重新读取不会调用模型。', confirmLabel: '重新读取', cancelLabel: '保留编辑' });
      if (!confirmed || !owns()) return;
    }
    return reload();
  }, 'ghost', { help: '重新读取权威 Prompt 库与版本；会替换编辑表单，先复制未保存内容。' }));
  async function savePrompt() {
    if (!owns() || saving || save.disabled) return;
    const revision = edits, previousIds = new Set(config.prompts.map(item => item.id)), value = { ...(picker.value ? { id: picker.value } : {}), name: name.value.trim(), prompt: body.value.trim(), context_menu: menu.checked };
    saving = true; sync();
    try {
      const next = await quickChatAction('prompt_save', { prompt: value, expected_revision: config.revision }); if (!owns()) return;
      config = next; note.textContent = 'Prompt 已保存，没有调用模型。';
      if (revision === edits) paintConfig(value.id || config.prompts.find(item => !previousIds.has(item.id) && item.name === value.name && item.prompt === value.prompt)?.id || '');
      else note.textContent += ' 保留你随后输入的未保存修改。';
    } catch (error) { if (owns()) note.textContent = `保存失败或版本冲突：${error.message}；编辑保留，请复制后重新读取。`; }
    finally { saving = false; if (owns()) sync(); }
  }
  async function removePrompt() {
    if (!owns() || saving || remove.disabled) return; const value = selected(), revision = edits;
    const confirmed = await confirmDialog({ title: `删除 Prompt「${value.name}」？`, message: '会移除保存项与右键注册；已有对话及其 Prompt 快照不变。', danger: true, confirmLabel: '删除', cancelLabel: '保留', confirmHelp: '删除这个自定义 Prompt，不删除已有对话。' });
    if (!confirmed || !owns() || saving) return;
    saving = true; sync();
    try { const next = await quickChatAction('prompt_remove', { id: value.id, expected_revision: config.revision }); if (!owns()) return; config = next; if (edits === revision) paintConfig(''); note.textContent = 'Prompt 已删除，既有对话保留。'; }
    catch (error) { if (owns()) note.textContent = `删除失败：${error.message}；请保留编辑并重新读取。`; }
    finally { saving = false; if (owns()) sync(); }
  }
  const [promptModule] = pageModules(library, { scope: 'quick-chat-prompts', entries: [{ section: library, key: 'library', mode: 'fold' }] });
  library.insertBefore(note, promptModule.body);
  sync(); await Promise.all([reload(), import('./quick-chat-model.js').then(module => {
    if (owns()) return module.renderChatModel({ container: models, ownsPage: owns });
  })]);
}
