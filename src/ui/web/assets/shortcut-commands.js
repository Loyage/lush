import { el, button, badge, block } from './dom.js';
import { api, action } from './api.js';
import { confirmDialog } from './dialog.js';
import { show } from './messages.js';
import { workerLabel } from './worker-label.js';
import { absolute } from './format.js';
import { COMMAND_WARNING, validCommands } from './shortcut-command-model.js';

function field(label, tag = 'input', value = '') {
  const wrap = el('label', label, 'hook-field'), input = el(tag); input.setAttribute('aria-label', label); input.value = value;
  wrap.append(input); return { wrap, input };
}
function resultText(result) {
  return `命令结果：${({ succeeded: '执行成功', failed: '执行失败', unknown: '结果未知', running: '执行中' })[result?.status] || '结果未知'}${result?.exit_code != null ? ` · 退出码 ${result.exit_code}` : ''}${result?.reason === 'timeout' ? ' · 超时（最长 60 秒）' : result?.reason === 'output_limit' ? ' · 输出超限（64 KiB）' : ''}；原始输出不公开。`;
}

/** Project-local explicit authorization. Its live editor is retained by the owning page across unrelated repaints. */
export function renderShortcutCommands({ catalogue, ownsPage, busy, setBusy, setEditing, onCatalogue, onCommands }) {
  const section = block('快捷指令'); section.classList.add('shortcut-commands');
  section.append(el('p', '先注册并授权指令，再由 Hook 引用明确版本或选择 Worker 手动执行。修改即撤权，已有 Hook 引用不会自动升级。', 'hint'), el('p', COMMAND_WARNING, 'hint hook-command-warning'));
  const model = catalogue.commands;
  if (!validCommands(model)) {
    section.append(el('p', '快捷指令目录暂不可用；请更新后台服务并刷新。不能注册、授权或执行指令。', 'error')); return section;
  }
  const editor = el('div', undefined, 'shortcut-command-editor hook-editor');
  let editing = false, saving = false;
  const controls = [];
  function control(label, fn, help, unavailable = () => null) {
    const host = el('span', undefined, 'help-host'), node = button(label, async () => {
      if (!ownsPage() || busy() || saving || unavailable()) return;
      await fn();
    }, 'ghost hook-button', { help });
    const sync = () => {
      const reason = unavailable() || (busy() || saving ? '正在确认或保存，请稍候。' : null);
      node.disabled = !!reason; host.tabIndex = reason ? 0 : -1;
      host.setAttribute('data-help', `${reason || ''} ${help}`);
    };
    const clicked = node.onclick; node.onclick = async () => { await clicked(); syncAll(); };
    host.append(node); controls.push(sync); sync(); return host;
  }
  function syncAll() { for (const sync of controls) sync(); }
  function closeEditor() { editing = false; setEditing(false); editor.replaceChildren(); syncAll(); }
  function beginEditor() { if (editing || busy()) return false; editing = true; setEditing(true); syncAll(); return true; }
  async function mutation(method, params, confirmation) {
    if (!ownsPage() || busy() || saving) return;
    saving = true; setBusy(true); syncAll();
    try {
      if (confirmation && !await confirmDialog(confirmation)) return;
      if (!ownsPage()) return;
      const result = await action(method, params, { refresh: false });
      if (!ownsPage()) return;
      onCatalogue(result); show('快捷指令配置已保存；已开始的副作用不会撤回。');
    } catch (error) { if (ownsPage()) show(`${error.message}；未假定授权已改变，请刷新目录确认。`, 'error'); }
    finally { saving = false; setBusy(false); if (ownsPage()) syncAll(); }
  }
  function edit(initial = null) {
    if (!beginEditor()) return;
    const name = field('快捷指令名称', 'input', initial?.name || ''), command = field('Shell 命令', 'textarea', initial?.command || '');
    name.input.maxLength = 120; command.input.rows = 6; command.input.spellcheck = false; command.input.classList.add('hook-command-input'); command.input.maxLength = 16000;
    const error = el('p', undefined, 'error'); error.setAttribute('role', 'alert');
    editor.replaceChildren(el('h3', initial ? `编辑快捷指令：${initial.name}` : '注册快捷指令'), name.wrap, command.wrap,
      el('p', '保存仅注册内容，不执行、不授权；修改名称或正文会产生新版本并撤销授权，需再次授权并明确更新 Hook 引用。', 'hint'), error);
    const save = button('保存快捷指令', async () => {
      if (!ownsPage() || busy() || saving) return;
      if (!name.input.value.trim() || !command.input.value.trim()) { error.textContent = '请填写快捷指令名称和 Shell 命令。'; return; }
      const params = { command: { ...(initial ? { id: initial.id } : {}), name: name.input.value.trim(), command: command.input.value }, expected_revision: model.revision };
      saving = true; setBusy(true); name.input.disabled = command.input.disabled = cancel.disabled = true; syncAll();
      try {
        const result = await action('hooks.command_save', params, { refresh: false });
        if (!ownsPage()) return;
        closeEditor(); onCatalogue(result); show('快捷指令已保存为未授权版本；请显式授权后使用。');
      } catch (failure) { if (ownsPage()) { error.textContent = `${failure.message}；编辑已保留，版本冲突请复制正文后刷新。`; show(error.textContent, 'error'); } }
      finally { saving = false; setBusy(false); if (ownsPage()) { name.input.disabled = command.input.disabled = cancel.disabled = false; syncAll(); } }
    }, 'hook-button', { help: '仅保存项目指令；不执行、不授权。修改后撤权且不会自动更新 Hook 引用。' });
    const cancel = button('取消指令编辑', () => { if (!saving) closeEditor(); }, 'ghost'); editor.append(save, cancel);
  }
  async function run(command) {
    if (!beginEditor()) return;
    editor.replaceChildren(el('h3', `手动执行：${command.name} · v${command.version}`), el('p', '正在读取可选 Worker…', 'hint'));
    try {
      // Parent candidates include main; activity also includes child Workers, which
      // cannot be development input parents but can own a Shell working directory.
      const [parents, activity] = await Promise.all([api('/api/input-parents'), api('/api/snapshot')]);
      if (!ownsPage() || !editing) return;
      if (!Array.isArray(parents?.items) || !Array.isArray(activity?.tasks)) throw new Error('Worker 列表不可用');
      const data = { items: [...new Map([...activity.tasks.filter(item => ['main', 'owner', 'order', 'child'].includes(item.task_kind)
        && !['completed', 'failed', 'cancelled'].includes(item.status)), ...parents.items].map(item => [item.id, item])).values()] };
      const worker = field('执行目录 Worker', 'select');
      const blank = el('option', '请选择 Worker 的真实工作目录'); blank.value = ''; worker.input.append(blank);
      for (const item of data.items) {
        if (!Number.isSafeInteger(item.id) || item.id < 1 || !item.branch) continue;
        const option = el('option', `${workerLabel(item)} · ${item.branch}${item.freeze ? ' · 冻结，暂不可执行' : ''}`);
        option.value = String(item.id); option.disabled = !!item.freeze; worker.input.append(option);
      }
      const error = el('p', undefined, 'error'); error.setAttribute('role', 'alert');
      const preview = el('pre', command.command, 'hook-action-preview'); preview.setAttribute('data-worker-links', 'off');
      editor.replaceChildren(el('h3', `手动执行：${command.name} · v${command.version}`), preview, worker.wrap,
        el('p', '将在所选 Worker 目录执行一次，不安装 Hook。候选来自父 Worker 列表和活动 Worker 窗口；不按编号推算身份。冻结、调用尚未退出或其他安全门阻塞时拒绝，不自动排队或重试。', 'hint'), error);
      const execute = button('确认执行一次', async () => {
        if (!ownsPage() || busy() || saving) return;
        const target = data.items.find(item => String(item.id) === worker.input.value);
        if (!target || target.freeze) { error.textContent = '请选择未冻结的有效 Worker。'; return; }
        const params = { id: command.id, version: command.version, worker_id: target.id, expected_revision: model.revision };
        saving = true; setBusy(true); worker.input.disabled = cancel.disabled = true; syncAll();
        let completed = false;
        try {
          if (!await confirmDialog({ title: '执行已授权快捷指令一次？', message: `${COMMAND_WARNING} 目标：${workerLabel(target)} · ${target.branch}`,
            detail: command.command, confirmLabel: '执行一次', danger: true, confirmHelp: '以 daemon 用户权限执行所选版本一次；可能产生不可逆副作用，不调用 Agent。' }) || !ownsPage()) return;
          const result = await action('hooks.command_run', params, { refresh: false });
          if (!ownsPage()) return;
          completed = true; closeEditor();
          onCommands(result.commands); show(resultText(result.command_result), result.command_result?.status === 'succeeded' ? 'info' : 'error');
        } catch (failure) { if (ownsPage()) { error.textContent = `${failure.message}；目标选择保留。请检查执行记录，不要盲目重试未知结果。`; show(error.textContent, 'error'); } }
        finally { saving = false; setBusy(false); if (ownsPage()) { worker.input.disabled = false; execute.disabled = completed; cancel.disabled = false; syncAll(); } }
      }, 'hook-button', { help: '在明确选择的 Worker 工作目录执行已授权版本一次；安全门不通过就拒绝，不调用 Agent。' });
      const cancel = button('取消手动执行', () => { if (!saving) closeEditor(); }, 'ghost'); editor.append(execute, cancel);
    } catch (failure) { if (ownsPage()) editor.replaceChildren(el('p', `读取 Worker 失败：${failure.message}；不会改投 main。`, 'error'), button('取消手动执行', closeEditor, 'ghost')); }
  }
  section.append(control('注册快捷指令', () => edit(), '注册当前项目的 Shell 指令；保存不授权也不执行。', () => editing ? '请先保存或取消当前编辑。' : null));
  for (const command of model.items) {
    const card = el('article', undefined, 'hook-mount shortcut-command'); card.dataset.commandId = command.id;
    const head = el('div', undefined, 'hook-mount-head'); head.append(el('strong', command.name), badge(`v${command.version}`), badge(command.authorized ? '已授权' : '未授权／已撤权'));
    const preview = el('pre', command.command, 'hook-action-preview'); preview.setAttribute('data-worker-links', 'off'); card.append(head, preview);
    const buttons = el('div', undefined, 'actions');
    buttons.append(control('编辑快捷指令', () => edit(command), '修改将产生新版本并撤权；已有 Hook 不会自动升级。', () => editing ? '请先保存或取消当前编辑。' : null),
      control(command.authorized ? '撤销授权' : '授权当前版本', () => mutation('hooks.command_authorize', { id: command.id, version: command.version, authorized: !command.authorized, expected_revision: model.revision },
        { title: command.authorized ? '撤销快捷指令授权？' : `授权快捷指令「${command.name}」v${command.version}？`, message: command.authorized
          ? '停止此版本未来手动和 Hook 执行；不会撤回已开始的副作用，也不重放旧触发。' : `${COMMAND_WARNING} 授权仅针对所展示的确切版本，Hook 仍须独立挂载和启用。`,
        ...(command.authorized ? {} : { detail: command.command }), confirmLabel: command.authorized ? '确认撤权' : '授权此版本', danger: true,
        confirmHelp: command.authorized ? '撤销此版本未来执行权限，不取消已开始的副作用。' : '允许用户和已启用 Hook 执行此版本 Shell 命令；不是沙箱，不调用 Agent。' }),
      command.authorized ? '撤销此版本未来执行授权，不撤回已开始的副作用。' : '明确授权此确切版本供手动执行和 Hook 引用；不是沙箱，不调用 Agent。', () => editing ? '请先保存或取消当前编辑。' : null),
      control('手动执行', () => run(command), '选择 Worker 的真实目录并确认执行一次；安全门仍须通过，不调用 Agent。', () => !command.authorized ? '此版本未授权，请先授权。' : editing ? '请先保存或取消当前编辑。' : null),
      control('删除快捷指令', () => mutation('hooks.command_remove', { id: command.id, expected_revision: model.revision },
        { title: `删除快捷指令「${command.name}」？`, message: '删除未来可用的授权，引用它的 Hook 将不可执行；不撤回已开始的副作用，执行历史保留。', confirmLabel: '删除指令', danger: true, confirmHelp: '删除项目指令并阻止引用它的未来执行；历史及既有成果保留。' }),
      '删除指令使已有 Hook 引用不可执行；执行历史和既有成果不撤回。', () => editing ? '请先保存或取消当前编辑。' : null));
    card.append(buttons);
    if (command.last_execution) {
      const last = command.last_execution;
      card.append(el('p', `最近执行：${last.worker_id ? workerLabel(last.worker_id, last.worker_number) : 'Worker 未知'} · ${absolute(last.finished_at || last.created_at)}`, 'hint'),
        el('p', resultText(last.command_result || { status: last.status }), last.status === 'failed' || last.status === 'unknown' ? 'error' : 'hint'));
    }
    section.append(card);
  }
  if (!model.items.length) section.append(el('p', '尚未注册快捷指令；先注册并授权，再在 Hook 中选择。', 'hint'));
  section.append(editor); return section;
}
