import { el, button, block } from './dom.js';
import { api, action } from './api.js';
import { automationModule } from './automation-module.js';
import { commandKind, commandBody, modernCommands, PROMPT_WARNING, COMMAND_WARNING, validCommands } from './shortcut-command-model.js';
import { commandDirectory, commandDetail } from './shortcut-command-directory.js';
import { confirmDialog } from './dialog.js';
import { show } from './messages.js';
import { createShortcutRuns } from './shortcut-command-runs.js';

function field(label, tag = 'input', value = '') {
  const wrap = el('label', undefined, 'hook-field'), input = el(tag); input.setAttribute('aria-label', label); input.value = value;
  wrap.append(el('span', label), input); return { wrap, input };
}

/** Retain the actual directory/editor nodes through catalogue reads, folds and subpages. */
export function renderShortcutCommands(options) {
  const { catalogue, ownsPage, busy, setBusy } = options;
  const section = el('div', undefined, 'shortcut-commands'), folds = options.folds || new Map();
  const introduction = el('p', '先注册并授权指令，再由 Hook 引用明确版本。修改即撤权，已有 Hook 引用不会自动升级。', 'hint'); section.append(introduction);
  let latest = catalogue.commands, subpage = 'settings';
  let management = validCommands(latest) ? renderShortcutCommandManagement({ ...options, model: latest }) : el('div'); management.classList.add('shortcut-command-management');
  if (!validCommands(latest)) management.append(el('p', '快捷指令目录暂不可用；请更新后台服务并刷新。不能注册或授权指令。', 'error'));
  const runs = createShortcutRuns({ ownsPage, busy, setBusy, active: false });
  const historyModule = block('运行记录'); historyModule.classList.add('shortcut-history-module'); historyModule.append(runs.history);
  const summary = () => validCommands(latest) ? `${latest.items.length} 项 · ${latest.items.filter(item => item.authorized).length} 已授权；授权和 Hook 启停独立。` : '指令目录不可用；安全历史独立查询。';
  automationModule(historyModule, 'command-history', folds, summary());
  runs.onHistoryStatus(text => { historyModule.moduleSummary.textContent = text; historyModule.moduleSummary.hidden = !text; }); section.append(management, historyModule);
  section.setSubpage = next => { subpage = next; section.hidden = subpage === 'settings'; for (const child of section.children) child.hidden = child === historyModule ? subpage !== 'history' : subpage !== 'commands'; management.setActive?.(subpage === 'commands'); runs.setActive(subpage === 'history'); };
  section.updateCommands = (next, nextCatalogue = null) => {
    latest = next; runs.update();
    if (!management.updateCommands && validCommands(next)) { management = renderShortcutCommandManagement({ ...options, catalogue: nextCatalogue || catalogue, model: next }); management.classList.add('shortcut-command-management'); section.replaceChildren(introduction, management, historyModule); section.setSubpage(subpage); }
    management.updateCommands?.(next, nextCatalogue);
  };
  section.dispose = () => runs.dispose(); return section;
}

export function renderShortcutCommandManagement({ catalogue, model: initialModel, ownsPage, busy, setBusy, setEditing, onCatalogue,
  filterCommand = () => true, allowCreate = true }) {
  const management = el('div'), detail = el('div', undefined, 'shortcut-command-detail'), editor = el('div', undefined, 'shortcut-command-editor hook-editor');
  const listPage = el('div'), detailPage = el('div', undefined, 'shortcut-command-detail-page'), unavailable = el('p', '指令目录暂不可用；已加载记录只读，草稿保留。请更新后台并刷新后操作。', 'error'); unavailable.hidden = true;
  let available = true, model = { ...initialModel, items: initialModel.items.filter(filterCommand) }, editing = false, saving = false, generation = 0, detailVersion = null, active = false, mode = 'list', listScroll = 0;
  const current = () => ownsPage() && active && available;
  function showPage(next) {
    if (mode === 'list' && next === 'detail') listScroll = document.getElementById('detail')?.scrollTop || 0;
    mode = next; listPage.hidden = next !== 'list'; detailPage.hidden = next !== 'detail';
    if (next === 'list') { generation++; const panel = document.getElementById('detail'); if (panel) panel.scrollTop = listScroll; directory.focusSelected(); }
  }
  let modern = modernCommands(catalogue);
  const controls = [];
  const directory = commandDirectory({ model, label: '查找管理指令', locked: () => !available || editing || saving || busy(), onSelect: () => { paintDetail(true); showPage('detail'); } });
  function control(label, fn, help, className = '', lockEditing = true) {
    const host = el('span', undefined, 'help-host'), node = button(label, async () => {
      if (!current() || saving || busy() || lockEditing && editing) return;
      await fn();
    }, `ghost hook-button ${className}`, { help });
    const sync = () => {
      const reason = !available ? '指令目录不可用；请更新后台并刷新。' : saving || busy() ? '正在确认或保存，请稍候。' : lockEditing && editing ? '请先保存或取消当前编辑。' : null;
      node.disabled = !!reason; host.tabIndex = reason ? 0 : -1; host.setAttribute('data-help', `${reason || ''} ${help}`);
    };
    const clicked = node.onclick; node.onclick = async () => { await clicked(); syncAll(); };
    host.append(node); controls.push(sync); sync(); return host;
  }
  function syncAll() { for (const sync of controls) sync(); directory.sync(); }
  function closeEditor() { generation++; editing = false; detail.hidden = false; editor.replaceChildren(); setEditing(false); paintDetail(true); syncAll(); }
  async function mutation(method, params, confirmation) {
    const epoch = generation;
    saving = true; setBusy(true); syncAll();
    try {
      if (confirmation && !await confirmDialog(confirmation) || !current() || epoch !== generation) return;
      const result = await action(method, params, { refresh: false });
      if (current() && epoch === generation) { if (!validCommands(result?.commands)) throw new Error('配置保存响应未确认'); onCatalogue(result); if (method === 'hooks.command_remove') showPage('list'); show('快捷指令配置已保存；已开始的副作用不会撤回。'); }
      else management.needsRefresh = true;
    } catch (error) { if (current() && epoch === generation) show(`${error.message}；未假定授权已改变，请刷新目录确认。不自动重发。`, 'error'); }
    finally { saving = false; setBusy(false); management.needsRefresh ||= !current(); if (ownsPage()) syncAll(); }
  }
  async function edit(initial = null) {
    if (editing || busy()) return;
    showPage('detail'); generation++;
    const revision = model.revision, editModern = modern;
    editing = true; detail.hidden = true; setEditing(true); syncAll();
    const name = field('快捷指令名称', 'input', initial?.name || ''), kind = field('指令类型', 'select');
    for (const [value, label] of editModern ? [['shell', 'Shell'], ['prompt', '提示词']] : [['shell', 'Shell（旧后台）']]) { const option = el('option', label); option.value = value; kind.input.append(option); }
    kind.input.value = commandKind(initial);
    const shell = field('Shell 命令', 'textarea', initial?.command || ''), prompt = field('提示词正文', 'textarea', initial?.prompt || '');
    name.input.maxLength = 120;
    for (const entry of [shell, prompt]) { entry.input.rows = 6; entry.input.maxLength = 16000; entry.input.spellcheck = false; entry.input.classList.add('hook-command-input'); }
    const metadata = [['description', '作用说明', 2000], ['when_to_use', '调用场景', 4000], ['tags', '标签（每行一个）', 32 * 81 - 1], ['examples', '调用示例', 8000], ['warnings', '风险提醒', 4000]].map(([key, label, limit]) => ({ key, label, limit, ...field(label, 'textarea', key === 'tags' ? (initial?.tags || []).join('\n') : initial?.[key] || '') }));
    for (const item of metadata) { item.wrap.hidden = !editModern; item.input.rows = 2; item.input.maxLength = item.limit; }
    const tagField = metadata.find(item => item.key === 'tags');
    tagField.wrap.append(el('span', '最多 32 个标签，每个最多 80 字符；空行忽略。', 'hint'));
    const error = el('p', undefined, 'error'); error.setAttribute('role', 'alert');
    const draftActive = () => current() && mode === 'detail' && editing;
    const promptType = () => kind.input.value === 'prompt', warning = el('p', undefined, 'hint hook-command-warning');
    function paintKind() { shell.wrap.hidden = promptType(); prompt.wrap.hidden = !promptType(); warning.textContent = promptType() ? PROMPT_WARNING : COMMAND_WARNING; }
    kind.input.onchange = paintKind; paintKind();
    const save = button('保存快捷指令', async () => {
      if (!draftActive() || busy() || saving) return;
      const body = promptType() ? prompt.input.value : shell.input.value;
      error.textContent = '';
      if (!name.input.value.trim() || !body.trim()) { error.textContent = '请填写快捷指令名称和 Shell 命令或提示词正文。'; return; }
      const values = [{ label: '快捷指令名称', value: name.input.value.trim(), limit: 120 }, { label: promptType() ? '提示词正文' : 'Shell 命令', value: body, limit: 16000 },
        ...(editModern ? metadata.filter(item => item.key !== 'tags').map(item => ({ label: item.label, value: item.input.value, limit: item.limit })) : [])];
      const invalid = values.find(item => item.value.includes('\0') || item.value.length > item.limit);
      if (invalid) { error.textContent = `${invalid.label}${invalid.value.includes('\0') ? '不能包含 NUL 字符' : `最多 ${invalid.limit} 字符`}；草稿已保留。`; return; }
      const tags = tagField.input.value.split('\n').map(value => value.trim()).filter(Boolean);
      if (editModern && (tags.length > 32 || tags.some(tag => tag.length > 80 || tag.includes('\0')))) {
        error.textContent = '标签最多 32 个，每个最多 80 字符，不能包含 NUL 字符；草稿已保留。'; return;
      }
      // Omit retired defaults: the backend preserves historical default_worker_id.
      const definition = { ...(initial ? { id: initial.id } : {}), name: name.input.value.trim(), [promptType() ? 'prompt' : 'command']: body };
      if (editModern) { definition.kind = kind.input.value; for (const item of metadata) definition[item.key] = item.key === 'tags' ? tags : item.input.value; }
      const epoch = generation;
      saving = true; setBusy(true); for (const input of ['input', 'textarea', 'select', 'button'].flatMap(tag => [...editor.querySelectorAll(tag)])) input.disabled = true; syncAll();
      try {
        const result = await action('hooks.command_save', { command: definition, expected_revision: revision }, { refresh: false });
        if (!draftActive() || epoch !== generation) { management.needsRefresh = true; return; }
        if (!validCommands(result?.commands)) throw new Error('保存响应未确认');
        // Select the saved entry without changing the submitted search/filter state.
        const saved = result.commands?.items?.find(item => initial ? item.id === initial.id : !model.items.some(old => old.id === item.id));
        if (saved) directory.select(saved.id);
        closeEditor(); onCatalogue(result); show('快捷指令已保存为未授权版本；请显式授权后使用。');
      } catch (failure) { if (draftActive() && epoch === generation) { error.textContent = `${failure.message}；编辑已保留，版本冲突请核对目录后再保存，不自动重发。`; show(error.textContent, 'error'); } }
      finally { saving = false; setBusy(false); management.needsRefresh ||= !ownsPage() || !active; if (ownsPage() && editing) for (const input of ['input', 'textarea', 'select', 'button'].flatMap(tag => [...editor.querySelectorAll(tag)])) input.disabled = false; if (ownsPage()) syncAll(); }
    }, 'hook-button', { help: '只保存定义，不授权、不执行、不调用 Agent；任何修改升版本并撤权，Hook 不自动升级。' });
    const cancel = button('取消指令编辑', () => { if (!saving) closeEditor(); }, 'ghost');
    editor.replaceChildren(el('h3', initial ? `编辑快捷指令：${initial.name}` : '注册快捷指令'), name.wrap, kind.wrap, ...metadata.map(item => item.wrap), shell.wrap, prompt.wrap,
      el('p', '保存仅注册内容，不执行、不授权、不调用 Agent；修改名称、元数据或正文会产生新版本并撤销授权。已有 Hook 引用不会自动升级。', 'hint'),
      warning, ...(!editModern ? [el('p', '旧后台仅支持 Shell；元数据、提示词和导出须更新后台后使用，不伪装支持。', 'hint')] : []), error, save, cancel);
  }
  async function exportCommand(command) {
    const epoch = ++generation;
    try {
      const result = await api(`/api/hooks/commands/export?id=${encodeURIComponent(command.id)}&version=${command.version}`);
      if (!current() || mode !== 'detail' || epoch !== generation || directory.selected()?.id !== command.id) return;
      if (typeof result?.markdown !== 'string' || typeof result?.filename !== 'string' || !/^[^/\\]+\.md$/.test(result.filename)) throw new Error('导出响应不可用');
      const preview = el('pre', result.markdown, 'hook-action-preview'); preview.setAttribute('data-worker-links', 'off');
      const download = el('a', `下载 ${result.filename}`, 'hook-help-link'); download.download = result.filename; download.href = `data:text/markdown;charset=utf-8,${encodeURIComponent(result.markdown)}`;
      editor.replaceChildren(el('p', '只导出所选版本的 Skill 风格 Markdown，不安装、不注入 Agent，也不授予执行权限。', 'hint'), preview, download);
    } catch { if (current() && epoch === generation) show('导出接口不可用；请更新后台与界面服务。不自动回退本地拼接，不会安装或注入 Skill。', 'error'); }
  }
  function paintDetail(force = false) {
    const command = directory.selected(), identity = command ? `${command.id}:${command.version}:${command.authorized}` : '';
    if (!force && identity === detailVersion) return; detailVersion = identity;
    if (!editing) { generation++; editor.replaceChildren(); }
    // Controls from discarded details must not accumulate on periodic history updates.
    controls.splice(2); detail.replaceChildren();
    if (!command) { detail.append(el('p', model.items.length ? '原选择已删除；请明确选择另一条指令。' : '尚未注册快捷指令；先注册并授权，再在 Hook 中选择。', 'hint')); return; }
    const prompt = commandKind(command) === 'prompt', warning = prompt ? PROMPT_WARNING : COMMAND_WARNING, card = commandDetail(command);
    card.append(el('p', warning, 'hint hook-command-warning'));
    const buttons = el('div', undefined, 'actions');
    buttons.append(control('编辑快捷指令', () => edit(command), '修改将产生新版本并撤权；已有 Hook 不会自动升级。'),
      control(command.authorized ? '撤销授权' : '授权当前版本', () => mutation('hooks.command_authorize', { id: command.id, version: command.version, authorized: !command.authorized, expected_revision: model.revision },
        { title: command.authorized ? '撤销快捷指令授权？' : `授权快捷指令「${command.name}」v${command.version}？`, message: command.authorized ? '停止此版本未来 Hook 执行；不会撤回已开始的副作用，也不重放旧触发。' : `${warning} 授权仅针对所展示的确切版本，Hook 仍须独立挂载和启用。`,
          ...(command.authorized ? {} : { detail: commandBody(command) }), confirmLabel: command.authorized ? '确认撤权' : '授权此版本', danger: true, confirmHelp: '保存此版本未来执行授权；授权本身不运行 Shell、不启动 Agent。' }),
        command.authorized ? '撤销此版本未来执行授权，不撤回已开始的副作用。' : `明确授权此版本供 Hook 引用。${warning}`, command.authorized ? 'command-revoke' : 'command-authorize'),
      control('删除快捷指令', () => mutation('hooks.command_remove', { id: command.id, expected_revision: model.revision }, { title: `删除快捷指令「${command.name}」？`, message: '删除未来可用的授权，引用它的 Hook 将不可执行；不撤回已开始的副作用，执行历史保留。', confirmLabel: '删除指令', danger: true, confirmHelp: '删除指令，保留执行历史和既有成果。' }), '删除指令使已有 Hook 引用不可执行；历史与成果保留。'),
      control('导出 Markdown', () => exportCommand(command), '读取此确切版本并导出 Skill 风格 Markdown；不安装、不注入 Agent、不授权。'));
    card.append(buttons); detail.append(card);
  }
  const listActions = el('div', undefined, 'actions');
  const resume = button('继续指令编辑', () => { if (current() && editing && !saving) showPage('detail'); }, 'ghost');
  const create = control('注册快捷指令', () => edit(), '注册当前项目指令；保存不授权也不执行。'); create.hidden = !allowCreate;
  listActions.append(create, resume);
  listPage.append(listActions, directory.node);
  const back = button('返回指令列表', () => { if (current() && !saving && !busy()) showPage('list'); }, 'ghost');
  const backHost = el('span', undefined, 'help-host'); backHost.append(back);
  detailPage.append(backHost, detail, editor); detailPage.hidden = true;
  management.append(el('h2', '指令管理'), unavailable, el('p', '管理定义和版本授权；执行结果在历史记录子页面查看。保存不执行，修改即撤权。', 'hint'), listPage, detailPage);
  controls.push(() => { resume.hidden = !editing; back.disabled = saving || busy(); backHost.tabIndex = back.disabled ? 0 : -1; if (back.disabled) backHost.setAttribute('data-help', '正在确认或保存，请稍候再返回指令列表。'); else backHost.removeAttribute('data-help'); });
  management.setActive = value => {
    if (active !== value) generation++; active = value;
    if (current()) {
      if (editing && !saving) for (const input of ['input', 'textarea', 'select', 'button'].flatMap(tag => [...editor.querySelectorAll(tag)])) input.disabled = false;
      syncAll();
    }
  };
  syncAll(); management.updateCommands = (next, nextCatalogue) => {
    available = validCommands(next); if (available) management.needsRefresh = false; unavailable.hidden = available;
    if (available) { model = { ...next, items: next.items.filter(filterCommand) }; modern = modernCommands(nextCatalogue || { commands: next }); directory.update(model); if (!editing && mode === 'detail') paintDetail(); }
    syncAll();
  }; return management;
}
