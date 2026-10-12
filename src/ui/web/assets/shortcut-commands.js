import { el, button, badge, block } from './dom.js';
import { api, action } from './api.js';
import { automationModule } from './automation-module.js';
import { commandWorkers, workerDirectoryReason } from './shortcut-command-model.js';
import { workerLabel } from './worker-label.js';
import { confirmDialog } from './dialog.js';
import { show } from './messages.js';
import { createShortcutRuns } from './shortcut-command-runs.js';
import { COMMAND_WARNING, validCommands } from './shortcut-command-model.js';

function field(label, tag = 'input', value = '') {
  const wrap = el('label', label, 'hook-field'), input = el(tag); input.setAttribute('aria-label', label); input.value = value;
  wrap.append(input); return { wrap, input };
}

/** One page-owned component: retained history, separate controls, and revision-pinned drafts. */
export function renderShortcutCommands(options) {
  const { catalogue, ownsPage, busy, setBusy, setEditing, onCatalogue, onCommands } = options;
  const section = el('div', undefined, 'shortcut-commands');
  const folds = options.folds || new Map();
  section.append(el('p', '先注册并授权指令，再由 Hook 引用明确版本或选择 Worker 手动执行。修改即撤权，已有 Hook 引用不会自动升级。', 'hint'), el('p', COMMAND_WARNING, 'hint hook-command-warning'));
  const model = catalogue.commands;
  if (!validCommands(model)) {
    section.append(el('p', '快捷指令目录暂不可用；请更新后台服务并刷新。不能注册、授权或执行指令。', 'error')); return section;
  }
  const management = block('指令管理'); management.classList.add('shortcut-command-management');
  const managementBody = el('div'); management.append(managementBody);
  const runs = createShortcutRuns({ model, ownsPage, busy, setBusy, onCommands });
  let editing = false, latest = model, displayed = null, managerNode = null;
  function paintManagement() {
    if (!editing && displayed?.revision !== latest.revision) {
      displayed = latest;
      managerNode = renderManagement({ ...options, model: latest,
        setEditing(value) { editing = value; setEditing(value); if (!value) paintManagement(); } });
      managementBody.replaceChildren(managerNode);
    }
    managerNode?.syncControls?.();
  }
  paintManagement();
  const runModule = block('快捷指令运行'); runModule.classList.add('shortcut-run-module'); runModule.append(runs.node);
  const historyModule = block('运行记录'); historyModule.classList.add('shortcut-history-module'); historyModule.append(runs.history);
  const summary = () => `${latest.items.length} 项 · ${latest.items.filter(item => item.authorized).length} 已授权；授权和 Hook 启停独立。`;
  automationModule(runModule, 'command-run', folds, summary());
  automationModule(management, 'command-management', folds, summary());
  automationModule(historyModule, 'command-history', folds);
  runs.onHistoryStatus(text => { historyModule.moduleSummary.textContent = text; });
  section.append(runModule, management, historyModule);
  section.setSubpage = subpage => {
    for (const child of section.children) child.hidden = child === historyModule ? subpage !== 'history' : subpage === 'history';
  };
  section.updateCommands = next => { if (validCommands(next)) { latest = next; runs.update(next); paintManagement(); runModule.moduleSummary.textContent = management.moduleSummary.textContent = summary(); } };
  section.dispose = () => runs.dispose();
  return section;
}

function renderManagement({ model, ownsPage, busy, setBusy, setEditing, onCatalogue }) {
  const management = el('div'), editor = el('div', undefined, 'shortcut-command-editor hook-editor');
  let editing = false, saving = false;
  const controls = [];
  function control(label, fn, help, unavailable = () => null, className = '') {
    const host = el('span', undefined, 'help-host'), node = button(label, async () => {
      if (!ownsPage() || busy() || saving || unavailable()) return;
      await fn();
    }, `ghost hook-button ${className}`, { help });
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
  async function edit(initial = null) {
    if (!beginEditor()) return;
    const name = field('快捷指令名称', 'input', initial?.name || ''), command = field('Shell 命令', 'textarea', initial?.command || '');
    name.input.maxLength = 120; command.input.rows = 6; command.input.spellcheck = false; command.input.classList.add('hook-command-input'); command.input.maxLength = 16000;
    const error = el('p', undefined, 'error'); error.setAttribute('role', 'alert');
    const directory = field('默认执行目录 Worker', 'select');
    const blank = el('option', '无默认目录（运行时选择）'); blank.value = ''; directory.input.append(blank);
    const initialId = initial?.default_worker_id ?? null;
    directory.input.value = initialId === null ? '' : String(initialId);
    if (initialId !== null) { const retained = el('option', `${workerLabel(initialId)} · 正在核验保存的目录`); retained.value = String(initialId); directory.input.append(retained); directory.input.value = retained.value; }
    let candidates = null;
    const directoryStatus = el('p', '正在读取 main 与活动 Worker（含 child）…', 'hint');
    editor.replaceChildren(el('h3', initial ? `编辑快捷指令：${initial.name}` : '注册快捷指令'), name.wrap, command.wrap, directory.wrap, directoryStatus,
      el('p', '保存仅注册内容，不执行、不授权；修改名称、正文或默认目录会产生新版本并撤销授权。目录绑定当前项目的具体 Worker，不是路径，也不会改投 main；Hook 仍在挂载 Worker 目录执行。', 'hint'), error);
    const save = button('保存快捷指令', async () => {
      if (!ownsPage() || busy() || saving) return;
      if (!name.input.value.trim() || !command.input.value.trim()) { error.textContent = '请填写快捷指令名称和 Shell 命令。'; return; }
      const workerId = directory.input.value === '' ? null : Number(directory.input.value);
      const target = candidates?.find(item => item.id === workerId);
      if (workerId !== null && (!target || workerDirectoryReason(target))) { error.textContent = '默认目录失效、冻结或尚未核验；请选择有效 Worker，或显式选择无默认目录。'; return; }
      const params = { command: { ...(initial ? { id: initial.id } : {}), name: name.input.value.trim(), command: command.input.value, default_worker_id: workerId }, expected_revision: model.revision };
      saving = true; setBusy(true); name.input.disabled = command.input.disabled = directory.input.disabled = cancel.disabled = true; syncAll();
      try {
        const result = await action('hooks.command_save', params, { refresh: false });
        if (!ownsPage()) return;
        closeEditor(); onCatalogue(result); show('快捷指令已保存为未授权版本；请显式授权后使用。');
      } catch (failure) { if (ownsPage()) { error.textContent = `${failure.message}；编辑已保留，版本冲突请复制正文后刷新。`; show(error.textContent, 'error'); } }
      finally { saving = false; setBusy(false); if (ownsPage()) { name.input.disabled = command.input.disabled = directory.input.disabled = cancel.disabled = false; syncAll(); } }
    }, 'hook-button', { help: '仅保存项目指令；不执行、不授权。修改后撤权且不会自动更新 Hook 引用。' });
    const cancel = button('取消指令编辑', () => { if (!saving) closeEditor(); }, 'ghost'); editor.append(save, cancel);
    try {
      const [parents, snapshot] = await Promise.all([api('/api/input-parents'), api('/api/snapshot')]);
      if (!ownsPage() || editor.querySelector('[aria-label="默认执行目录 Worker"]') !== directory.input) return;
      candidates = commandWorkers(parents, snapshot);
      const value = directory.input.value;
      directory.input.replaceChildren(blank);
      for (const item of candidates) {
        const reason = workerDirectoryReason(item), option = el('option', `${workerLabel(item)} · ${item.branch}${reason ? ` · ${reason}` : ''}`);
        option.value = String(item.id); option.disabled = !!reason; directory.input.append(option);
      }
      if (value && !candidates.some(item => String(item.id) === value)) { const missing = el('option', `${workerLabel(Number(value))} · 保存的目录已失效`); missing.value = value; missing.disabled = true; directory.input.append(missing); }
      directory.input.value = value;
      directoryStatus.textContent = value && (!candidates.some(item => String(item.id) === value) || workerDirectoryReason(candidates.find(item => String(item.id) === value)))
        ? '保存的默认目录不可用；不会清空或改投 main，请显式改选。' : '绑定当前项目具体 Worker；无默认目录时每次运行手动选择。';
    } catch { if (ownsPage() && editor.querySelector('[aria-label="默认执行目录 Worker"]') === directory.input) directoryStatus.textContent = '目录读取失败；已有选择保留，不能保存未核验的目录，可显式选择无默认目录。'; }
  }
  management.append(el('p', '管理定义和版本授权；执行结果在历史记录子页面查看。保存不执行，修改即撤权。', 'hint'),
    control('注册快捷指令', () => edit(), '注册当前项目的 Shell 指令；保存不授权也不执行。', () => editing ? '请先保存或取消当前编辑。' : null));
  for (const command of model.items) {
    const card = el('article', undefined, 'hook-mount shortcut-command'); card.dataset.commandId = command.id;
    const head = el('div', undefined, 'hook-mount-head'); head.append(el('strong', command.name), badge(`v${command.version}`), badge(command.authorized ? '已授权' : '未授权／已撤权'));
    const preview = el('pre', command.command, 'hook-action-preview'); preview.setAttribute('data-worker-links', 'off'); card.append(head, preview);
    card.append(el('p', command.default_worker_id == null ? '默认目录：未设置，运行时选择' : `默认目录：${workerLabel(command.default_worker_id)}（项目 Worker）`, 'hint'));
    const buttons = el('div', undefined, 'actions');
    buttons.append(control('编辑快捷指令', () => edit(command), '修改将产生新版本并撤权；已有 Hook 不会自动升级。', () => editing ? '请先保存或取消当前编辑。' : null),
      control(command.authorized ? '撤销授权' : '授权当前版本', () => mutation('hooks.command_authorize', { id: command.id, version: command.version, authorized: !command.authorized, expected_revision: model.revision },
        { title: command.authorized ? '撤销快捷指令授权？' : `授权快捷指令「${command.name}」v${command.version}？`, message: command.authorized
          ? '停止此版本未来手动和 Hook 执行；不会撤回已开始的副作用，也不重放旧触发。' : `${COMMAND_WARNING} 授权仅针对所展示的确切版本，Hook 仍须独立挂载和启用。`,
        ...(command.authorized ? {} : { detail: command.command }), confirmLabel: command.authorized ? '确认撤权' : '授权此版本', danger: true,
        confirmHelp: command.authorized ? '撤销此版本未来执行权限，不取消已开始的副作用。' : '允许用户和已启用 Hook 执行此版本 Shell 命令；不是沙箱，不调用 Agent。' }),
      command.authorized ? '撤销此版本未来执行授权，不撤回已开始的副作用。' : '明确授权此确切版本供手动执行和 Hook 引用；不是沙箱，不调用 Agent。', () => editing ? '请先保存或取消当前编辑。' : null, command.authorized ? 'command-revoke' : 'command-authorize'),
      control('删除快捷指令', () => mutation('hooks.command_remove', { id: command.id, expected_revision: model.revision },
        { title: `删除快捷指令「${command.name}」？`, message: '删除未来可用的授权，引用它的 Hook 将不可执行；不撤回已开始的副作用，执行历史保留。', confirmLabel: '删除指令', danger: true, confirmHelp: '删除项目指令并阻止引用它的未来执行；历史及既有成果保留。' }),
      '删除指令使已有 Hook 引用不可执行；执行历史和既有成果不撤回。', () => editing ? '请先保存或取消当前编辑。' : null));
    card.append(buttons);
    management.append(card);
  }
  if (!model.items.length) management.append(el('p', '尚未注册快捷指令；先注册并授权，再在 Hook 中选择。', 'hint'));
  management.append(editor); management.syncControls = syncAll; return management;
}
