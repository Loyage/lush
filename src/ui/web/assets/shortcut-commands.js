import { el, button, block } from './dom.js';
import { api, action } from './api.js';
import { automationModule } from './automation-module.js';
import { commandWorkers, workerDirectoryReason, commandKind, commandBody, modernCommands, promptParents, PROMPT_WARNING, COMMAND_WARNING, validCommands } from './shortcut-command-model.js';
import { commandDirectory, commandDetail } from './shortcut-command-directory.js';
import { workerLabel } from './worker-label.js';
import { confirmDialog } from './dialog.js';
import { show } from './messages.js';
import { createShortcutRuns } from './shortcut-command-runs.js';

function field(label, tag = 'input', value = '') {
  const wrap = el('label', undefined, 'hook-field'), input = el(tag); input.setAttribute('aria-label', label); input.value = value;
  wrap.append(el('span', label), input); return { wrap, input };
}

/** Retain the actual directory/editor nodes through catalogue reads, folds and subpages. */
export function renderShortcutCommands(options) {
  const { catalogue, ownsPage, busy, setBusy, onCommands } = options;
  const section = el('div', undefined, 'shortcut-commands'), folds = options.folds || new Map();
  section.append(el('p', '先注册并授权指令，再由 Hook 引用明确版本或选择 Worker 手动执行。修改即撤权，已有 Hook 引用不会自动升级。', 'hint'), el('p', COMMAND_WARNING, 'hint hook-command-warning'));
  if (!validCommands(catalogue.commands)) {
    section.append(el('p', '快捷指令目录暂不可用；请更新后台服务并刷新。不能注册、授权或执行指令。', 'error')); return section;
  }
  let latest = catalogue.commands;
  const management = block('指令管理'); management.classList.add('shortcut-command-management');
  const manager = renderManagement({ ...options, model: latest }); management.append(manager);
  const runs = createShortcutRuns({ model: latest, ownsPage, busy, setBusy, onCommands });
  const runModule = block('快捷指令运行'); runModule.classList.add('shortcut-run-module'); runModule.append(runs.node);
  const historyModule = block('运行记录'); historyModule.classList.add('shortcut-history-module'); historyModule.append(runs.history);
  const summary = () => `${latest.items.length} 项 · ${latest.items.filter(item => item.authorized).length} 已授权；授权和 Hook 启停独立。`;
  automationModule(runModule, 'command-run', folds, summary()); automationModule(management, 'command-management', folds, summary()); automationModule(historyModule, 'command-history', folds);
  runs.onHistoryStatus(text => { historyModule.moduleSummary.textContent = text; historyModule.moduleSummary.hidden = !text; }); section.append(runModule, management, historyModule);
  section.setSubpage = subpage => { for (const child of section.children) child.hidden = child === historyModule ? subpage !== 'history' : subpage === 'history'; };
  section.updateCommands = (next, nextCatalogue = null) => { if (validCommands(next)) { latest = next; runs.update(next); manager.updateCommands(next, nextCatalogue); runModule.moduleSummary.textContent = management.moduleSummary.textContent = summary(); } };
  section.dispose = () => runs.dispose(); return section;
}

function renderManagement({ catalogue, model: initialModel, ownsPage, busy, setBusy, setEditing, onCatalogue }) {
  const management = el('div'), detail = el('div', undefined, 'shortcut-command-detail'), editor = el('div', undefined, 'shortcut-command-editor hook-editor');
  let model = initialModel, editing = false, saving = false, generation = 0, detailVersion = null;
  let modern = modernCommands(catalogue);
  const controls = [];
  const directory = commandDirectory({ model, label: '查找管理指令', locked: () => editing || saving || busy(), onSelect: () => paintDetail(true) });
  function control(label, fn, help, className = '', lockEditing = true) {
    const host = el('span', undefined, 'help-host'), node = button(label, async () => {
      if (!ownsPage() || saving || busy() || lockEditing && editing) return;
      await fn();
    }, `ghost hook-button ${className}`, { help });
    const sync = () => {
      const reason = saving || busy() ? '正在确认或保存，请稍候。' : lockEditing && editing ? '请先保存或取消当前编辑。' : null;
      node.disabled = !!reason; host.tabIndex = reason ? 0 : -1; host.setAttribute('data-help', `${reason || ''} ${help}`);
    };
    const clicked = node.onclick; node.onclick = async () => { await clicked(); syncAll(); };
    host.append(node); controls.push(sync); sync(); return host;
  }
  function syncAll() { for (const sync of controls) sync(); directory.sync(); }
  function closeEditor() { generation++; editing = false; editor.replaceChildren(); setEditing(false); paintDetail(true); syncAll(); }
  async function mutation(method, params, confirmation) {
    saving = true; setBusy(true); syncAll();
    try {
      if (confirmation && !await confirmDialog(confirmation) || !ownsPage()) return;
      const result = await action(method, params, { refresh: false });
      if (ownsPage()) { onCatalogue(result); show('快捷指令配置已保存；已开始的副作用不会撤回。'); }
    } catch (error) { if (ownsPage()) show(`${error.message}；未假定授权已改变，请刷新目录确认。不自动重发。`, 'error'); }
    finally { saving = false; setBusy(false); if (ownsPage()) syncAll(); }
  }
  async function edit(initial = null) {
    if (editing || busy()) return;
    const epoch = ++generation, revision = model.revision, editModern = modern;
    editing = true; setEditing(true); syncAll();
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
    const target = field('默认执行目录 Worker', 'select'), blank = el('option', '无默认目标（运行时选择）'); blank.value = '';
    const initialId = initial?.default_worker_id ?? null; target.input.append(blank);
    if (initialId !== null) { const retained = el('option', `${workerLabel(initialId)} · 正在核验保存的目标`); retained.value = String(initialId); target.input.append(retained); }
    target.input.value = initialId === null ? '' : String(initialId);
    const targetStatus = el('p', undefined, 'hint'), error = el('p', undefined, 'error'); error.setAttribute('role', 'alert');
    let candidates = null, targetRead = 0;
    const draftActive = () => ownsPage() && editing && generation === epoch;
    const promptType = () => kind.input.value === 'prompt';
    async function loadTargets() {
      const read = ++targetRead, wantedKind = kind.input.value; candidates = null; targetStatus.textContent = '正在读取可选 Worker…';
      try {
        const parents = await api('/api/input-parents');
        const snapshot = wantedKind === 'shell' ? await api('/api/snapshot') : null;
        if (!draftActive() || read !== targetRead) return;
        candidates = wantedKind === 'prompt' ? promptParents(parents) : commandWorkers(parents, snapshot);
        const value = target.input.value; target.input.replaceChildren(blank);
        for (const item of candidates) { const reason = workerDirectoryReason(item), option = el('option', `${workerLabel(item)} · ${item.branch}${reason ? ` · ${reason}` : ''}`); option.value = String(item.id); option.disabled = !!reason; target.input.append(option); }
        if (value && !candidates.some(item => String(item.id) === value)) { const missing = el('option', `${workerLabel(Number(value))} · 保存的目标已失效`); missing.value = value; missing.disabled = true; target.input.append(missing); }
        target.input.value = value; targetStatus.textContent = '保存的目标不可用时不会清空或改投 main；请显式改选。';
      } catch { if (draftActive() && read === targetRead) targetStatus.textContent = '目标读取失败；已有选择保留，不能保存未核验目标。请更新服务，不会回退其他接口或 main。'; }
    }
    function paintKind() { shell.wrap.hidden = promptType(); prompt.wrap.hidden = !promptType(); const label = promptType() ? '默认父 Worker' : '默认执行目录 Worker'; target.input.setAttribute('aria-label', label); target.wrap.querySelector('span').textContent = label; }
    kind.input.onchange = () => { paintKind(); void loadTargets(); }; paintKind();
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
      const workerId = target.input.value === '' ? null : Number(target.input.value), selectedTarget = candidates?.find(item => item.id === workerId);
      if (workerId !== null && (!selectedTarget || workerDirectoryReason(selectedTarget))) { error.textContent = '默认目录失效、冻结或尚未核验；请选择有效 Worker，或显式选择无默认目标。'; return; }
      const definition = { ...(initial ? { id: initial.id } : {}), name: name.input.value.trim(), [promptType() ? 'prompt' : 'command']: body, default_worker_id: workerId };
      if (editModern) { definition.kind = kind.input.value; for (const item of metadata) definition[item.key] = item.key === 'tags' ? tags : item.input.value; }
      saving = true; setBusy(true); for (const input of ['input', 'textarea', 'select', 'button'].flatMap(tag => [...editor.querySelectorAll(tag)])) input.disabled = true; syncAll();
      try {
        const result = await action('hooks.command_save', { command: definition, expected_revision: revision }, { refresh: false });
        if (!draftActive()) return;
        // Select the saved entry without changing the submitted search/filter state.
        const saved = result.commands?.items?.find(item => initial ? item.id === initial.id : !model.items.some(old => old.id === item.id));
        if (saved) directory.select(saved.id);
        closeEditor(); onCatalogue(result); show('快捷指令已保存为未授权版本；请显式授权后使用。');
      } catch (failure) { if (draftActive()) { error.textContent = `${failure.message}；编辑已保留，版本冲突请核对目录后再保存，不自动重发。`; show(error.textContent, 'error'); } }
      finally { saving = false; setBusy(false); if (draftActive()) for (const input of ['input', 'textarea', 'select', 'button'].flatMap(tag => [...editor.querySelectorAll(tag)])) input.disabled = false; if (ownsPage()) syncAll(); }
    }, 'hook-button', { help: '只保存定义，不授权、不执行、不调用 Agent；任何修改升版本并撤权，Hook 不自动升级。' });
    const cancel = button('取消指令编辑', () => { if (!saving) closeEditor(); }, 'ghost');
    editor.replaceChildren(el('h3', initial ? `编辑快捷指令：${initial.name}` : '注册快捷指令'), name.wrap, kind.wrap, ...metadata.map(item => item.wrap), shell.wrap, prompt.wrap, target.wrap, targetStatus,
      el('p', '保存仅注册内容，不执行、不授权；修改名称、元数据、正文或默认目标会产生新版本并撤销授权。Shell 使用具体 Worker 真实目录，提示词使用父 Worker 创建独立指令；不支持 child 父级。', 'hint'),
      el('p', editModern ? PROMPT_WARNING : '旧后台仅支持 Shell；元数据、提示词和导出须更新后台后使用，不伪装支持。', 'hint'), error, save, cancel);
    await loadTargets();
  }
  async function exportCommand(command) {
    const epoch = ++generation;
    try {
      const result = await api(`/api/hooks/commands/export?id=${encodeURIComponent(command.id)}&version=${command.version}`);
      if (!ownsPage() || epoch !== generation || directory.selected()?.id !== command.id) return;
      if (typeof result?.markdown !== 'string' || typeof result?.filename !== 'string' || !/^[^/\\]+\.md$/.test(result.filename)) throw new Error('导出响应不可用');
      const preview = el('pre', result.markdown, 'hook-action-preview'); preview.setAttribute('data-worker-links', 'off');
      const download = el('a', `下载 ${result.filename}`, 'hook-help-link'); download.download = result.filename; download.href = `data:text/markdown;charset=utf-8,${encodeURIComponent(result.markdown)}`;
      editor.replaceChildren(el('p', '只导出所选版本的 Skill 风格 Markdown，不安装、不注入 Agent，也不授予执行权限。', 'hint'), preview, download);
    } catch { if (ownsPage() && epoch === generation) show('导出接口不可用；请更新后台与界面服务。不自动回退本地拼接，不会安装或注入 Skill。', 'error'); }
  }
  function paintDetail(force = false) {
    const command = directory.selected(), identity = command ? `${command.id}:${command.version}:${command.authorized}` : '';
    if (!force && identity === detailVersion) return; detailVersion = identity;
    if (!editing) { generation++; editor.replaceChildren(); }
    // Controls from discarded details must not accumulate on periodic history updates.
    controls.splice(1); detail.replaceChildren();
    if (!command) { detail.append(el('p', model.items.length ? '原选择已删除；请明确选择另一条指令。' : '尚未注册快捷指令；先注册并授权，再在 Hook 中选择。', 'hint')); return; }
    const prompt = commandKind(command) === 'prompt', warning = prompt ? PROMPT_WARNING : COMMAND_WARNING, card = commandDetail(command);
    card.append(el('p', command.default_worker_id == null ? '默认目标：未设置，运行时选择' : `默认${prompt ? '父 Worker' : '目录'}：${workerLabel(command.default_worker_id)}（项目 Worker）`, 'hint'));
    const buttons = el('div', undefined, 'actions');
    buttons.append(control('编辑快捷指令', () => edit(command), '修改将产生新版本并撤权；已有 Hook 不会自动升级。'),
      control(command.authorized ? '撤销授权' : '授权当前版本', () => mutation('hooks.command_authorize', { id: command.id, version: command.version, authorized: !command.authorized, expected_revision: model.revision },
        { title: command.authorized ? '撤销快捷指令授权？' : `授权快捷指令「${command.name}」v${command.version}？`, message: command.authorized ? '停止此版本未来手动和 Hook 执行；不会撤回已开始的副作用，也不重放旧触发。' : `${warning} 授权仅针对所展示的确切版本，Hook 仍须独立挂载和启用。`,
          ...(command.authorized ? {} : { detail: commandBody(command) }), confirmLabel: command.authorized ? '确认撤权' : '授权此版本', danger: true, confirmHelp: '保存此版本未来执行授权；授权本身不运行 Shell、不启动 Agent。' }),
        command.authorized ? '撤销此版本未来执行授权，不撤回已开始的副作用。' : `明确授权此版本供手动执行和 Hook 引用。${warning}`, command.authorized ? 'command-revoke' : 'command-authorize'),
      control('删除快捷指令', () => mutation('hooks.command_remove', { id: command.id, expected_revision: model.revision }, { title: `删除快捷指令「${command.name}」？`, message: '删除未来可用的授权，引用它的 Hook 将不可执行；不撤回已开始的副作用，执行历史保留。', confirmLabel: '删除指令', danger: true, confirmHelp: '删除指令，保留执行历史和既有成果。' }), '删除指令使已有 Hook 引用不可执行；历史与成果保留。'),
      control('导出 Markdown', () => exportCommand(command), '读取此确切版本并导出 Skill 风格 Markdown；不安装、不注入 Agent、不授权。'));
    card.append(buttons); detail.append(card);
  }
  management.append(el('p', '管理定义和版本授权；执行结果在历史记录子页面查看。保存不执行，修改即撤权。', 'hint'),
    control('注册快捷指令', () => edit(), '注册当前项目指令；保存不授权也不执行。'), directory.node, detail, editor);
  paintDetail(); management.updateCommands = (next, nextCatalogue) => { model = next; modern = modernCommands(nextCatalogue || { commands: next }); directory.update(next); if (!editing) paintDetail(); syncAll(); }; return management;
}
