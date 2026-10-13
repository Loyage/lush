import { $, el, button } from './dom.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { confirmDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { show } from './messages.js';
import { refreshDeviceAutomation, saveDeviceAutomation, validDeviceAutomation } from './workspace-automation.js';
import { pageModules } from './page-modules.js';

export async function openWorkspaceAutomation({ push = true } = {}) {
  const view = activateDetailView({ view: 'automation', title: '全局自动化', context: '用户工作台',
    hint: '设备自动选择 · 项目流程在项目内设置', hash: '#automation', push });
  const root = el('div', undefined, 'workbench-view workspace-automation'); $('detail').replaceChildren(root);
  const state = { model: null, busy: false, error: '', uncertain: false };
  const owns = () => ui.view === view && $('detail').querySelector('.workspace-automation') === root;
  const status = el('p', undefined, 'hint'); status.setAttribute('role', 'status');
  async function load() {
    if (state.busy) return;
    state.busy = true; paint();
    try {
      const model = await refreshDeviceAutomation();
      if (!owns()) return;
      if (!validDeviceAutomation(model)) throw new Error('尚未取得有效设备策略');
      state.model = model; state.error = ''; state.uncertain = false;
    } catch (error) { if (owns()) { state.error = `读取设备自动化失败：${error.message}`; state.uncertain = true; } }
    finally { state.busy = false; if (owns()) paint(); }
  }
  function guarded(control, reason) {
    const host = el('span', undefined, 'help-host'); host.append(control);
    if (reason) { control.disabled = true; host.tabIndex = 0; host.setAttribute('data-help', reason); }
    return host;
  }
  async function save(enabled) {
    if (!owns() || !state.model || state.busy || state.uncertain) return;
    const revision = state.model.revision; state.busy = true; state.error = ''; paint();
    try {
      const model = await saveDeviceAutomation({ auto_select: { enabled } }, revision);
      if (!owns()) return;
      if (!validDeviceAutomation(model) || model.auto_select.enabled !== enabled) throw new Error('保存结果未确认，请重新读取后检查，勿重复提交');
      state.model = model; state.uncertain = false;
      show('设备自动选择已保存；已有 Worker 的流程授权不变。');
    } catch (error) { if (owns()) { state.uncertain = true; state.error = `${error.message}；先重新读取最新策略，勿重复提交未确认操作。`; } }
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
      if (owns()) await save(!enabled);
    }, enabled ? 'ghost' : 'primary', { agent: !enabled, help: enabled ? '关闭所有项目的未来自动答复，不撤回已有答案或停止已开始调用。'
      : agentHelp('保存设备级授权，已有及之后待答的 Worker 可能继续调用。') });
    card.append(el('p', enabled ? '已保存：开启' : '已保存：关闭', 'automation-saved'), guarded(toggle, state.busy ? '正在确认或保存，请稍候。' : state.uncertain ? '保存结果未确认，先重新读取策略。' : null));
    card.append(el('p', '浏览器或 Host 关闭不会撤销策略；每个项目 daemon 独立执行，停止的后台不会因设置自动启动。', 'hint'));
    return card;
  }
  function paint() {
    if (!owns()) return;
    const head = el('header', undefined, 'workbench-hero');
    head.append(el('span', 'AUTOMATION', 'eyebrow'), el('h1', '全局自动化'), el('p', '自动选择跟随设备用户；Worker 自动化默认值在各项目独立设置。', 'hint'));
    const reload = button('重新读取策略', () => owns() ? load() : undefined, 'ghost'); reload.disabled = state.busy;
    head.append(guarded(reload, state.busy ? '正在读取或保存设备策略，请稍候。' : null)); root.replaceChildren(head);
    if (state.error) { const error = el('p', state.error, 'error'); error.setAttribute('role', 'alert'); root.append(error); }
    if (state.model) {
      const card = autoSelectCard(), heading = el('div', undefined, 'section-title'), title = card.querySelector('h2');
      card.insertBefore(heading, title); heading.append(title); root.append(card);
      const views = pageModules(root, { scope: 'workspace-automation', entries: [{ section: card, key: 'auto-select', mode: 'fold' }] });
      for (const view of views) {
        const saved = view.content.querySelector('.automation-saved');
        if (saved) view.section.insertBefore(saved, view.body);
      }
    } else if (!state.error) { status.textContent = '正在读取设备策略…'; root.append(status); }
    root.append(el('p', '成果自动合并与验收、新 Worker 默认值、默认显示原则和待验收告知，均在对应项目的“项目自动化”设置；具体 Worker 的授权在其自动化模块查看。这里不再设置设备级完工默认值，旧配置与已有授权保留。', 'hint'));
  }
  paint(); await load();
}
