import { $, el, button } from './dom.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { refreshDeviceAutomation } from './workspace-automation.js';
import { createAutoSelectAction } from './auto-select-action.js';
import { pageModules } from './page-modules.js';

export async function openWorkspaceAutomation({ push = true } = {}) {
  const owner = document;
  const view = activateDetailView({ view: 'automation', title: '全局自动化', context: '用户工作台',
    hint: '设备自动选择 · 项目流程在项目内设置', hash: '#automation', push });
  const root = el('div', undefined, 'workbench-view workspace-automation'); $('detail').replaceChildren(root);
  const owns = () => owner === globalThis.document && ui.view === view && $('detail').querySelector('.workspace-automation') === root;
  const head = el('header', undefined, 'workbench-hero');
  head.append(el('span', 'AUTOMATION', 'eyebrow'), el('h1', '全局自动化'), el('p', '自动选择跟随设备用户；Worker 自动化默认值在各项目独立设置。', 'hint'));
  const reload = button('重新读取策略', async () => { if (owns()) try { await refreshDeviceAutomation(); } catch {} }, 'ghost'); head.append(reload); root.append(head);
  const card = el('section', undefined, 'workspace-automation-card');
  card.append(el('h2', '全局自动选择'), el('p', '自动答复此设备各项目已有和新到的未答问题。单选选择第一项；多选和文字问答请 Agent 自行判断，来源标记为“Lush 自动选择”。', 'hint'));
  const action = createAutoSelectAction({ ownsPage: owns });
  card.append(action.root, el('p', '浏览器或 Host 关闭不会撤销策略；每个项目 daemon 独立执行，停止的后台不会因设置自动启动。', 'hint'));
  const heading = el('div', undefined, 'section-title'), title = card.querySelector('h2');
  card.insertBefore(heading, title); heading.append(title); root.append(card);
  const views = pageModules(root, { scope: 'workspace-automation', entries: [{ section: card, key: 'auto-select', mode: 'fold' }] });
  action.status.classList.add('automation-saved');
  for (const item of views) item.section.insertBefore(action.status, item.body);
  root.append(el('p', '成果自动合并与验收、新 Worker 默认值、默认显示原则和待验收告知，均在对应项目的“项目自动化”设置；具体 Worker 的授权在其自动化模块查看。这里不再设置设备级完工默认值，旧配置与已有授权保留。', 'hint'));
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => {
    if (!owns()) { action.dispose(); observer.disconnect(); }
  }) : null;
  observer?.observe(owner.documentElement, { childList: true, subtree: true });
  await action.ready;
}
