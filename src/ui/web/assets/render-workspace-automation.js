import { $, el, button } from './dom.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { confirmDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { show } from './messages.js';
import { completionLevelButtons } from './hook-controls.js';
import { refreshDeviceAutomation, saveDeviceAutomation, validDeviceAutomation } from './workspace-automation.js';

export async function openWorkspaceAutomation({ push = true } = {}) {
  const view = activateDetailView({ view: 'automation', title: '全局自动化', context: '用户工作台',
    hint: '设备唯一策略 · 项目后台执行', hash: '#automation', push });
  const root = el('div', undefined, 'workbench-view workspace-automation'); $('detail').replaceChildren(root);
  const state = { model: null, draft: null, busy: false, error: '', uncertain: false };
  const owns = () => ui.view === view && $('detail').querySelector('.workspace-automation') === root;
  const normalizeLevel = level => level === 'archive' ? 'accept' : level;
  const normalizedDefaults = model => ({ ...model.completion_defaults, level: normalizeLevel(model.completion_defaults.level) });
  const status = el('p', undefined, 'hint'); status.setAttribute('role', 'status');
  async function load() {
    if (state.busy) return;
    state.busy = true; paint();
    try {
      const model = await refreshDeviceAutomation();
      if (!owns()) return;
      if (!validDeviceAutomation(model)) throw new Error('尚未取得有效设备策略');
      state.model = model; state.draft = normalizedDefaults(model); state.error = ''; state.uncertain = false;
    } catch (error) { if (owns()) { state.error = `读取设备自动化失败：${error.message}`; state.uncertain = true; } }
    finally { state.busy = false; if (owns()) paint(); }
  }
  function guarded(control, reason) {
    const host = el('span', undefined, 'help-host'); host.append(control);
    if (reason) { control.disabled = true; host.tabIndex = 0; host.setAttribute('data-help', reason); }
    return host;
  }
  async function save(patch) {
    if (!owns() || !state.model || state.busy || state.uncertain) return;
    const revision = state.model.revision; state.busy = true; state.error = ''; paint();
    try {
      const model = await saveDeviceAutomation(patch, revision);
      if (!owns()) return;
      if (!validDeviceAutomation(model)
        || (patch.auto_select && model.auto_select.enabled !== patch.auto_select.enabled)
        || (patch.completion_defaults && (model.completion_defaults.enabled !== patch.completion_defaults.enabled || normalizeLevel(model.completion_defaults.level) !== patch.completion_defaults.level))) {
        throw new Error('保存结果未确认，请重新读取后检查，勿重复提交');
      }
      state.model = model;
      // Saving the independent automatic-selection policy must not discard an unsaved completion draft.
      if (patch.completion_defaults) state.draft = normalizedDefaults(model);
      state.uncertain = false;
      show('设备自动化已保存；已有 Worker 的运行参数和流程授权不变。');
    } catch (error) { if (owns()) { state.uncertain = true; state.error = `${error.message}；编辑值已保留。先重新读取最新策略，勿重复提交未确认操作。`; } }
    finally { state.busy = false; if (owns()) paint(); }
  }
  function autoSelectCard() {
    const card = el('section', undefined, 'workspace-automation-card');
    card.append(el('h2', '全局自动选择'), el('p', '自动答复此设备各项目已有和新到的未答问题。单选选择第一项；多选和文字问答请 Agent 自行判断，来源标记为“Lush 自动选择”。', 'hint'));
    const enabled = state.model.auto_select.enabled;
    const toggle = button(enabled ? '关闭全局自动选择' : '开启全局自动选择', async () => {
      if (!owns() || state.busy || state.uncertain) return;
      if (!enabled && !await confirmDialog({ title: '开启此设备的全局自动选择？',
        message: '持续授权所有使用此设备配置的项目后台，自动答复已有和新到问题。可能恢复多个 Worker 并产生调用费用。不会启动已停止的项目；项目以后恢复时再按安全边界处理。关闭只撤销未来答复，不撤回已经写入的答案或调用。',
        confirmLabel: '授权并开启', agent: true, confirmHelp: agentHelp('开启设备级持续授权，并允许各项目已有待答 Worker 继续。') })) return;
      if (owns()) await save({ auto_select: { enabled: !enabled } });
    }, enabled ? 'ghost' : 'primary', { agent: !enabled, help: enabled ? '关闭所有项目的未来自动答复，不撤回已有答案或停止已开始调用。'
      : agentHelp('保存设备级授权，已有及之后待答的 Worker 可能继续调用。') });
    card.append(el('p', enabled ? '已保存：开启' : '已保存：关闭', 'automation-saved'), guarded(toggle, state.busy ? '正在确认或保存，请稍候。' : state.uncertain ? '保存结果未确认，先重新读取策略。' : null));
    card.append(el('p', '浏览器或 Host 关闭不会撤销策略；每个项目 daemon 独立执行，停止的后台不会因设置自动启动。', 'hint'));
    return card;
  }
  function defaultsCard() {
    const card = el('section', undefined, 'workspace-automation-card completion-defaults');
    card.append(el('h2', '新指令结束后的默认流程'), el('p', '此设备所有项目之后实际创建的新指令使用同一默认授权；保存不修改已有 Worker，child 的锁定流程与父 Agent 验收不变。验收表示不再有异议，同时归档并回收 worktree/ref；保留运行历史，脏工作区会阻止验收。旧自动验收及归档授权也采用此统一语义。', 'hint'));
    const draft = state.draft, saved = normalizedDefaults(state.model);
    const enabled = el('input'); enabled.type = 'checkbox'; enabled.checked = draft.enabled; enabled.disabled = state.busy;
    enabled.setAttribute('aria-label', '启用新指令默认自动流程');
    const label = el('label', undefined, 'hook-check'); label.append(enabled, el('span', '启用新指令默认自动流程'));
    const { group, choices } = completionLevelButtons('设备默认最高自动环节', level => {
      if (owns() && !state.busy) { draft.level = level; sync(); }
    }, { includeOff: false });
    const dirty = () => draft.enabled !== saved.enabled || draft.level !== saved.level;
    const saveButton = button('保存设备默认', async () => {
      if (!owns() || state.busy || state.uncertain || !dirty()) return;
      const patch = { ...draft };
      if (patch.enabled && patch.level === 'accept' && !await confirmDialog({ title: '授权所有项目的未来新指令自动到验收？',
        message: '仅影响之后实际创建的新指令：交付合并后通过安全验收，表示不再有异议，同时归档 Worker 及后代并清理 worktree/ref；保留 Worker、会话与 Git 历史，不丢弃脏改动，脏工作区会阻止验收。自动验收不是质量评审。保存不调用已有 Agent；未来分歧可能唤醒新 Worker。',
        confirmLabel: '授权并保存默认', danger: true, agent: true, confirmHelp: agentHelp('为所有项目未来新指令保存自动合并、验收及归档授权。') })) return;
      if (owns()) await save({ completion_defaults: patch });
    }, 'primary');
    const saveHost = el('span', undefined, 'help-host'); saveHost.append(saveButton);
    const summary = el('p', undefined, 'hint'); summary.setAttribute('role', 'status');
    function sync() {
      const names = { merge: '合并', accept: '验收' };
      for (const { level, control, host } of choices) {
        control.disabled = state.busy; control.setAttribute('aria-pressed', String(level === draft.level));
        control.classList.toggle('is-selected', level === draft.level);
        control.classList.toggle('is-included', ['merge', 'accept'].indexOf(level) < ['merge', 'accept'].indexOf(draft.level));
        const help = `选择未来新指令的默认最高环节“${names[level]}”；点击保存后才生效，不修改已有 Worker。${level === 'accept' ? '验收同时归档并回收 worktree/ref，保留运行历史；脏工作区会阻止验收，自动验收不保证业务质量。' : ''}`;
        control.setAttribute('data-help', help); host.setAttribute('data-help', help); host.tabIndex = control.disabled ? 0 : -1;
      }
      saveButton.disabled = state.busy || state.uncertain || !dirty();
      saveButton.classList.toggle('agent-call', draft.enabled);
      const help = draft.enabled ? agentHelp('保存所有项目未来新指令的自动流程授权，未来合并分歧可能调用 Agent。')
        : '关闭以后新指令的默认自动流程，记住所选环节，不修改已有 Worker。';
      saveButton.setAttribute('data-help', help);
      saveHost.tabIndex = saveButton.disabled ? 0 : -1;
      saveHost.setAttribute('data-help', `${saveButton.disabled ? state.busy ? '正在保存。' : state.uncertain ? '先重新读取未确认的保存结果。' : '没有未保存更改。' : ''}${help}`);
      summary.textContent = `已保存：${saved.enabled ? '启用' : '关闭'} · 自动到${names[saved.level]}${dirty() ? '；有未保存更改。' : '。'}`;
    }
    enabled.onchange = () => { if (owns() && !state.busy) { draft.enabled = enabled.checked; sync(); } };
    for (const { control } of choices) { const clicked = control.onclick; control.onclick = async () => { await clicked(); sync(); }; }
    sync(); card.append(label, group, summary, saveHost); return card;
  }
  function paint() {
    if (!owns()) return;
    const head = el('header', undefined, 'workbench-hero');
    head.append(el('span', 'AUTOMATION', 'eyebrow'), el('h1', '全局自动化'), el('p', '策略跟随设备用户，实际动作仍由来源项目在安全边界执行。', 'hint'));
    const reload = button('重新读取策略', async () => {
      if (state.busy) return;
      const dirty = state.draft && state.model && (state.draft.enabled !== state.model.completion_defaults.enabled || state.draft.level !== normalizeLevel(state.model.completion_defaults.level));
      if (dirty && !await confirmDialog({ title: '放弃未保存更改并重新读取？', message: '重新读取设备的权威默认流程，当前未保存编辑会丢失。', confirmLabel: '放弃并读取' })) return;
      if (owns()) await load();
    }, 'ghost'); reload.disabled = state.busy;
    reload.setAttribute('data-help', '只读取得最新设备策略，不调用 Agent。存在未保存更改时会先明确确认是否放弃。');
    head.append(guarded(reload, state.busy ? '正在读取或保存设备策略，请稍候。' : null)); root.replaceChildren(head);
    if (state.error) { const error = el('p', state.error, 'error'); error.setAttribute('role', 'alert'); root.append(error); }
    if (state.model) root.append(autoSelectCard(), defaultsCard());
    else if (!state.error) { status.textContent = '正在读取设备策略…'; root.append(status); }
    root.append(el('p', '仓库 Shell 命令授权、推送、时间信号与实际 Worker Hook 挂载仍在各项目“项目自动化”管理；这里不会复制它们的授权。', 'hint'));
  }
  paint(); await load();
}
