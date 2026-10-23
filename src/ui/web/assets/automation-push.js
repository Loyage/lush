import { el, button } from './dom.js';
import { paintDisclosure } from './view-controls.js';
import { api, action } from './api.js';
import { detail } from './navigate.js';
import { confirmDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { renderAutomationSettings } from './automation-settings.js';
import { commandReferencesIssue, commandSummary, validCommands, COMMAND_WARNING, PROMPT_WARNING } from './shortcut-command-model.js';

/** main alone owns the actual push attachment; no run evidence in project settings. */
export function renderPushAutomation(options) {
  const node = renderAutomationSettings({ ...options, feature: 'push' });
  let catalogue = options.catalogue, saving = false, uncertain = false, disposed = false, generation = 0;
  const owns = () => !disposed && (options.ownsPage?.() ?? true);
  const current = () => Array.isArray(catalogue?.command_example?.hooks?.mounts)
    ? catalogue.command_example.hooks.mounts.find(item => item?.id === catalogue.command_example.hook_id) : null;
  const supported = (mount, source) => Number.isSafeInteger(source?.worker_id) && source.worker_id > 0
    && source.hooks?.worker_id === source.worker_id && typeof source.hooks?.revision === 'string' && !!source.hooks.revision.trim()
    && typeof mount?.enabled === 'boolean' && Array.isArray(mount.actions) && mount.actions.every(item => item && typeof item.type === 'string');
  function enableIssue(mount) {
    const references = commandReferencesIssue(mount, catalogue);
    if (references) return references;
    if (!validCommands(catalogue?.commands)) return '快捷指令目录不可用；请更新服务并重新读取，不能授权执行。';
    if (!Array.isArray(catalogue?.actions) || mount.actions.some(item => typeof catalogue.actions.find(action => action?.type === item.type)?.agent_call !== 'boolean'))
      return '动作目录不可用或含未知动作；请到 main 核查，不能猜测 Agent 代价并授权。';
    return null;
  }
  // Use the registered action directory, including the existing no-start creation exception.
  const callsAgent = mount => Array.isArray(catalogue?.actions) && mount.actions.some(item => catalogue.actions.find(action => action?.type === item.type)?.agent_call === true
    && (item.type !== 'create_worker' || item.start !== false));
  const host = el('section', undefined, 'push-main-settings command-hook-example'), advanced = el('div', undefined, 'push-advanced-settings push-command-reference'); advanced.hidden = true;
  const status = el('p', undefined, 'hint'); status.setAttribute('role', 'status');
  node.extra.append(host);
  const savePush = async enabled => {
    const mount = current(), source = catalogue?.command_example;
    if (!owns() || saving || uncertain || enabled === mount?.enabled || !supported(mount, source) || mount.editable !== true || mount.locked
      || !mount.enabled && enableIssue(mount)) return;
    const request = ++generation, agent = enabled && callsAgent(mount);
    saving = true; paint(); let submitted = false;
    try {
      if (enabled) {
        const commands = mount.actions.filter(item => ['command', 'prompt_command'].includes(item.type));
        if (!await confirmDialog({ title: agent ? '启用指令 Hook？' : '启用 main 自动推送？', danger: true,
          message: `${commands.some(item => item.type === 'command') ? COMMAND_WARNING : commands.length ? PROMPT_WARNING : ''} 仅授权 main 实际挂载的未来节点；未来节点满足后按已授权固定版本执行，不立即执行。Git remote、上游与认证由用户配置。`,
          detail: commands.map(item => commandSummary(item, catalogue)).join('\n\n'),
          confirmLabel: agent ? '启用指令 Hook' : '确认启用推送', agent, confirmHelp: agent ? agentHelp('授权 main 挂载所引用指令及未来 Agent 动作；触发后按实际条件和安全门执行。') : '启用 main 实际挂载；保存不立即执行，未来副作用可能不可逆。' }) || !owns()) return;
        if (agent && !await confirmDialog({ title: '授权会安排 Agent 调用的 Hook？',
          message: '保存授权后，条件满足时可能启动或唤醒 Agent。定时只保证提交动作，不保证 Agent 准点开始。请到 main 核对节点、条件、目标和运行设置。',
          confirmLabel: '授权并挂载', agent: true, confirmHelp: agentHelp('允许 main 实际挂载在指定安全节点执行所配置的 Agent 调用。') })) return;
      }
      if (!owns() || enabled && enableIssue(mount)) return;
      submitted = true;
      const result = await action('worker.hook_update', { id: source.worker_id, hook_id: mount.id, enabled, expected_revision: source.hooks.revision }, { refresh: false });
      if (!owns() || request !== generation) { uncertain = true; return; }
      const next = result?.mounts?.find(item => item.id === mount.id);
      if (result.worker_id !== source.worker_id || typeof result.revision !== 'string' || !next || next.enabled !== enabled) throw new Error('推送保存响应未确认');
      catalogue = { ...catalogue, command_example: { ...source, hooks: result } }; status.textContent = 'main 推送授权已保存；未立即执行，不代表执行成功。';
    } catch (error) { uncertain = submitted; if (owns()) { status.textContent = `${error.message}；原设置保留，请重新读取核查，不自动重发。`; status.className = 'error'; } }
    finally { saving = false; paint(); }
  };
  const choices = [], group = el('div', undefined, 'hook-completion-levels'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', 'main 自动推送');
  for (const enabled of [false, true]) {
    const control = button(enabled ? '开启' : '关闭', () => savePush(enabled), 'hook-completion-level');
    const host = el('span', undefined, 'help-host'); host.append(control); choices.push({ enabled, control, host }); group.append(host);
  }
  const reload = button('重新读取推送设置', async () => {
    if (!owns() || saving) return;
    const request = ++generation; saving = true; paint();
    try { const result = await api('/api/hooks'); if (owns() && request === generation) { catalogue = result; uncertain = false; status.textContent = ''; status.className = 'hint'; } }
    catch (error) { if (owns()) { status.textContent = `推送设置读取失败：${error.message}`; status.className = 'error'; } }
    finally { saving = false; paint(); }
  }, 'ghost');
  const openAdvanced = button('', () => { if (!owns()) return; advanced.hidden = !advanced.hidden; paintAdvanced(); }, 'ghost');
  const paintAdvanced = () => paintDisclosure(openAdvanced, !advanced.hidden, { expand: '展开推送高级设置', collapse: '收起推送高级设置', help: '仅显示或隐藏推送设置，不保存或执行推送。' });
  paintAdvanced();
  for (const control of [...choices.map(item => item.control), reload]) { const click = control.onclick; control.onclick = async () => { await click(); paint(); }; }
  function paint() {
    if (!owns()) return;
    const mount = current(), source = catalogue?.command_example, available = supported(mount, source);

    const reason = saving ? '正在确认或保存。' : uncertain ? '离开期间或本次保存结果未确认，先重新读取核查。' : !available ? '推送挂载已删除或读面不可用；不会自动重装，历史保留。' : mount.editable !== true || mount.locked ? mount.reason || 'main 挂载当前不可编辑。' : !mount.enabled ? enableIssue(mount) || '' : '';
    reload.disabled = saving;
    for (const { enabled, control, host } of choices) {
      const blocked = reason && (!available || saving || uncertain || mount.editable !== true || mount.locked || enabled) ? reason : '';
      control.disabled = !!blocked || available && enabled === mount.enabled;
      control.setAttribute('aria-pressed', String(available && enabled === mount.enabled)); control.classList.toggle('is-selected', available && enabled === mount.enabled);
      const agent = available && enabled && callsAgent(mount); control.classList.toggle('agent-call', !!agent);
      const help = agent ? agentHelp('启用 main 实际挂载的未来动作，可能创建或恢复 Agent。') : '仅启停 main 实际推送挂载，不立即运行，不改变新 Worker 默认或合并授权。';
      control.setAttribute('data-help', help); host.setAttribute('data-help', `${blocked} ${help}`); host.tabIndex = control.disabled ? 0 : -1;
    }
    const summary = el('p', available ? `main 当前授权：${mount.enabled ? '开启' : '关闭'}（不是执行结果）。` : reason, available ? 'hint' : 'error');
    if (available && reason && !saving) summary.append(el('span', ` ${reason}`, 'error'));
    const mainLink = button('查看 main Worker 自动化', () => owns() && source?.worker_id ? detail(source.worker_id) : undefined, 'nav-link', { worker: source?.worker_id });
    mainLink.disabled = !Number.isSafeInteger(source?.worker_id) || source.worker_id < 1;
    advanced.replaceChildren(el('h2', '引用指令（只读）'), el('p', '挂载参数编辑及旧内联导入请到 main 自动化。定义修订请回项目登记目录；修订不改变旧挂载，须另行选择版本升级。这里不展示执行收据或运行记录。', 'hint'));
    if (!validCommands(catalogue?.commands)) advanced.append(el('p', '快捷指令目录不可用；不能校验指令引用。', 'error'));
    for (const item of Array.isArray(mount?.actions) ? mount.actions.filter(item => item && typeof item.type === 'string') : []) {
      const command = validCommands(catalogue?.commands) ? catalogue.commands.items.find(command => command.id === item.command_id) : null;
      if (!command) { if (item.command_id) advanced.append(el('p', '引用指令已删除或目录不可用；请到 main 核查。', 'error')); continue; }
      advanced.append(el('p', commandSummary(item, catalogue), 'hook-action-preview'));
    }
    const diagnostic = mount && (['failed', 'unknown'].includes(mount.state) || mount.reason);
    if (diagnostic) summary.append(el('span', ` · 需要核查：${mount.state === 'unknown' ? '结果未知，不自动重放。' : mount.state === 'failed' ? '执行失败。' : ''}${mount.reason || ''} 请到 main Worker 自动化查看诊断。`, 'error'));
    const actions = el('div', undefined, 'actions hook-actions'); actions.append(reload, mainLink, openAdvanced);
    node.feedback.replaceChildren(summary, status);
    host.replaceChildren(group, actions, advanced);
  }
  const select = node.setSubpage;
  node.setSubpage = () => { select(); paint(); return node.ready; };
  const dispose = node.dispose; node.dispose = () => { disposed = true; ++generation; dispose(); };
  paint(); return node;
}
