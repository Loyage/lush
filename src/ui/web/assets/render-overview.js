import { $, block, button, el, kv } from './dom.js';
import { workerKind, workerKindLabel } from './worker-kind.js';
import { HOT, absolute, statusOf, noticeNumber } from './format.js';
import { detail } from './navigate.js';
import { openNotice } from './render-notices.js';
import { ui } from './state.js';
import { workerLabel, rememberWorkers } from './worker-label.js';
import { projectMaintenanceRegion } from './project-maintenance.js';

/** Worker-first homepage using the existing studio layout, without old Intent/Plan/Candidate controls. */
export function renderOverview(data) {
  rememberWorkers(data.tasks);
  const tasks = (data.tasks || []).filter(task => ['order','child','main','owner'].includes(workerKind(task)));
  const open = (data.notices || []).filter(notice => notice.status === 'open' && notice.kind !== 'info');
  const acceptance = tasks.filter(task => task.status === 'awaiting_acceptance' && workerKind(task) === 'order');
  const parentConfirmation = tasks.filter(task => task.status === 'awaiting_acceptance' && task.task_kind === 'child');
  const active = tasks.filter(task => HOT.has(task.status) && task.status !== 'awaiting_acceptance' && !['main','owner'].includes(task.task_kind));
  const key = JSON.stringify([data.revision, tasks.map(task => `${task.id}:${task.worker_number ?? ''}:${task.updated_at}`), open.map(notice => notice.id)]);
  if (key === ui.overviewKey) return;
  ui.overviewKey = key;
  const panel = $('detail');
  const expanded = new Set([...panel.querySelectorAll('details[data-fold]')].filter(node => node.open).map(node => node.dataset.fold));
  const maintenance = projectMaintenanceRegion(data.status.maintenance, { offline: Boolean(ui.offline) });
  const focus = document.activeElement;
  const maintenanceFocus = [...maintenance.querySelectorAll('button')].some(node => node === focus || node.parentNode === focus) ? focus : null;
  panel.dataset.view = 'overview'; panel.replaceChildren();
  const hero = el('div', undefined, 'overview-hero');
  const copy = el('div');
  copy.append(el('span', 'WORKER / 目标与交付', 'eyebrow'), el('h1', '项目概览'),
    el('p', open.length ? `${open.length} 个问题等待你的决定。` : active.length ? `${active.length} 个 Worker 正在推进。` : acceptance.length ? `${acceptance.length} 个 Worker 等待验收，可追加输入继续开发。` : parentConfirmation.length ? `${parentConfirmation.length} 个派生 Worker 等待父 Agent 确认，无需你验收。` : '发送一条目标，创建独立 Worker。', 'hero-description'));
  hero.append(copy, el('div', '✳', 'hero-mark')); panel.append(hero, maintenance);
  maintenanceFocus?.focus({ preventScroll: true });

  const metrics = el('div', undefined, 'metrics');
  for (const [label, value, note, tone] of [
    ['Worker', tasks.length, '指令、子 Worker 与分支所有者', 'blue'],
    ['进行中', active.length, `${data.status.agents?.length ?? 0} 个 Agent 正在调用`, 'violet'],
    ['待验收', acceptance.length, `${parentConfirmation.length} 个派生 Worker 待父确认，无需你验收`, 'violet'],
    ['待我处理', open.length, open.length ? '需要你的答复' : '没有待答复问题', 'green'],
  ]) {
    const card = el('div', undefined, `metric tone-${tone}`);
    card.append(el('span', label, 'metric-label'), el('strong', String(value), 'metric-value'), el('span', note, 'metric-note'));
    metrics.append(card);
  }
  panel.append(metrics);

  const work = block('最近 Worker', String(tasks.length));
  if (!tasks.length) work.append(el('p', '还没有 Worker。在底部输入框描述目标即可开始。', 'empty-state compact'));
  for (const task of [...tasks].sort((a, b) => b.id - a.id).slice(0, 20)) {
    const row = el('div', undefined, 'branch-row');
    row.append(el('span', workerLabel(task), 'tid'), button(task.goal || workerKindLabel(task), () => detail(task.id), 'link'),
      el('span', statusOf(task).label, `chip c-${task.status}`));
    if (task.branch) row.append(el('span', task.branch, 'meta mono'));
    work.append(row);
  }
  panel.append(work);

  const decisions = block('需要你的决定', String(open.length));
  decisions.classList.add('attention-panel');
  if (!open.length) decisions.append(el('p', '暂时没有待决问题。', 'empty-state compact'));
  for (const notice of open) {
    const row = button('', () => openNotice(notice.id), 'attention-item');
    const text = el('span', undefined, 'attention-copy');
    text.append(el('span', `Worker ${workerLabel(notice.task_id, notice.task_worker_number)} · 等待答复`, 'eyebrow'), el('strong', `${noticeNumber(notice)} · ${notice.title}`));
    row.append(el('span', '?', 'attention-icon'), text, el('span', '去处理 →', 'attention-action'));
    decisions.append(row);
  }
  panel.append(decisions);

  const agents = block('运行中的 Agent', `${data.status.agents?.length ?? 0} / ${data.status.concurrency ?? 1}`);
  for (const agent of data.status.agents || []) {
    const row = el('div', undefined, 'row');
    row.append(el('span', '●', 'dot c-running'), button(`查看 Worker ${workerLabel(agent.task_id, agent.task_worker_number)}`, () => detail(agent.task_id), 'link'),
      el('span', agent.pid ? `pid ${agent.pid}` : 'pid 待上报', 'when'));
    agents.append(row);
  }
  if (!data.status.agents?.length) agents.append(el('p', '当前没有 Agent 调用。', 'hint'));
  panel.append(agents);

  const info = block('运行时');
  const grid = el('div', undefined, 'grid');
  grid.append(kv('项目', data.status.project, 'mono'), kv('provider', data.status.provider || '—'),
    kv('并发额度', String(data.status.concurrency ?? '—')),
    kv('版本', [data.status.version, data.status.fingerprint].filter(Boolean).join(' · ') || '—', 'mono'),
    kv('状态目录', data.status.home || '—', 'mono'), kv('启动', absolute(data.status.started_at) || '—'));
  info.append(grid);
  const runtime = el('details', undefined, 'disclosure'); runtime.dataset.fold = 'runtime'; runtime.open = expanded.has('runtime');
  runtime.append(el('summary', '运行时与项目配置'), info); panel.append(runtime);
}
