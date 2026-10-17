import { $, el, button, badge, block } from './dom.js';
import { api, action, isReadAbort } from './api.js';
import { projectBase } from './route.js';
import { ui } from './state.js';
import { confirmDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { workerLabel } from './worker-label.js';
import { bindWorkerPreview } from './entity-preview.js';

const STAGES = { preparing: '准备整合', resolving: '整合中', awaiting: '等待决定或资源', ready: '等待合入',
  landing: '正在合入', integrated: '已合并', failed: '整合失败', blocked: '落地待核查', withdrawn: '已取消', stale: '已失效' };
const ENDED = new Set(['integrated', 'withdrawn', 'stale']);
const positive = value => Number.isSafeInteger(value) && value > 0;
const stage = operation => STAGES[operation?.state] || '状态未知，请核查';
const valid = operation => positive(operation?.id) && typeof operation.revision === 'string' && operation.revision.length > 0
  && typeof operation.target_branch === 'string' && Array.isArray(operation.members) && Number.isSafeInteger(operation.member_count);
const START_HELP = agentHelp('固定此刻可准入的直接来源，创建一个整合 Worker 自主合并与验证，最终一次性合入此分支；不会改变来源父子关系，也不会自动验收来源。');

function linkWorker(worker, label = null) {
  if (!positive(worker?.id)) return el('span', '整合 Worker 身份尚未提供', 'warn');
  const node = el('a', label || `整合 Worker ${workerLabel(worker)}`, 'nav-link');
  node.setAttribute('href', `${projectBase()}/#worker-${worker.id}`); bindWorkerPreview(node, worker); return node;
}
function attached(root) {
  for (let at = root; at; at = at.parentNode) if (at === $('detail')) return true;
  return false;
}
function lifetime(root, ownsPage = () => true) {
  const view = ui.view, project = projectBase(), owner = globalThis.document;
  return () => owner === globalThis.document && view === ui.view && project === projectBase() && ownsPage() && attached(root);
}
function scopedRead(url, signal) {
  const controller = new AbortController(), page = ui.view?.id === 'task-graph' ? ui.taskGraphPage : null;
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  page?.controllers?.add(controller);
  return api(url, { signal: controller.signal }).finally(() => {
    signal?.removeEventListener('abort', abort); page?.controllers?.delete(controller);
  });
}
function notice(root, message, error = false) {
  const old = root.querySelector('.integration-feedback'); old?.remove();
  const node = el('p', message, `${error ? 'error' : 'hint'} integration-feedback`); node.setAttribute('role', 'status'); root.append(node);
}

/** Same bounded operation facts on source cards and target cards; no delivery-page dependency. */
export function integrationSummary(task, { showMerged = true } = {}) {
  const operation = task.merge_operation;
  if (!operation) return null;
  const root = el('section', undefined, 'integration-summary');
  if (!valid(operation)) { root.append(el('p', '整合状态不完整，请打开 Worker 详情核查。', 'warn')); return root; }
  root.dataset.integrationId = String(operation.id);
  if (showMerged || operation.state !== 'integrated')
    root.append(badge(`${ENDED.has(operation.state) ? '上次整合 · ' : ''}${stage(operation)}`, operation.state === 'integrated' ? 'b-completed' : 'b-awaiting'));
  root.append(el('span', `${operation.member_count} 个来源 · ${operation.target_branch}`), linkWorker(operation.worker));
  if (operation.error) root.append(el('p', operation.error, 'error integration-error'));
  if (operation.state === 'blocked') root.append(el('p', '落地结果需核查，不得盲目重试或再次开始。', 'error'));
  return root;
}

/** No eager preflight per graph node: the user explicitly reads the authoritative full plan. */
export function integrationControl(task, { refresh = () => {}, ownsPage = () => true, signal } = {}) {
  if (task.execution_retired === true || !['main', 'owner', 'order', 'child'].includes(task.task_kind) || !task.branch
    || ['completed', 'failed', 'cancelled'].includes(task.status) || task.archived || task.branch_archive?.archived) return null;
  const root = el('section', undefined, 'integration-control'), current = lifetime(root, ownsPage);
  const host = el('span', undefined, 'help-host'); host.setAttribute('data-help', START_HELP);
  const control = button('整合全部', () => {}, 'ghost', { agent: true, help: START_HELP });
  const active = task.merge_operation && !ENDED.has(task.merge_operation.state);
  if (active) { control.disabled = true; host.setAttribute('data-help', '已有整合操作，请打开整合 Worker 查看进度、待决或失败原因。'); host.tabIndex = 0; }
  host.append(control); root.append(host);
  let busy = false, accepted = null;
  control.onclick = async () => {
    if (!current() || busy || active || accepted) return;
    busy = true; control.disabled = true;
    host.setAttribute('data-help', '正在核对来源或等待确认，不会重复开始。');
    try {
      const plan = await scopedRead(`/api/branch-integrate-plan?branch=${encodeURIComponent(task.branch)}`, signal);
      if (!current()) return;
      if (plan?.branch !== task.branch || typeof plan.revision !== 'string' || !Array.isArray(plan.members)
        || !Array.isArray(plan.excluded) || !Number.isSafeInteger(plan.count) || typeof plan.ready !== 'boolean') throw Error('整合预检返回不完整，请更新服务或重新读取。');
      if (plan.active) {
        if (!valid(plan.active) || plan.active.target_branch !== task.branch) throw Error('当前整合操作状态或目标不匹配，请核查。');
        accepted = plan.active;
        root.append(integrationSummary({ merge_operation: accepted }));
        notice(root, '已有整合操作，未创建新的 Worker。'); return;
      }
      if (!plan.ready || !plan.count) { notice(root, plan.reason || '没有可准入的直接来源。'); return; }
      if (plan.count !== plan.members.length || plan.members.some(member => !positive(member.id) || typeof member.source_commit !== 'string'))
        throw Error('来源清单不完整，不能据此确认整合范围。');
      const detail = [`本次纳入 ${plan.count} 个来源：`, ...plan.members.map(member => `${workerLabel(member)} ${member.title || ''} · ${member.source_commit.slice(0, 12)}`),
        ...(plan.excluded.length ? ['', `未纳入 ${plan.excluded.length} 个来源：`, ...plan.excluded.map(member => `${workerLabel(member)} · ${member.reason}`)] : [])].join('\n');
      const confirmed = await confirmDialog({ title: `整合 ${task.branch} 的 ${plan.count} 个来源？`,
        message: '只固定本清单，之后完成的来源不加入。一个整合 Worker 自主选择顺序、适配并验证；全部成功后一次性合入目标。任一成员失败或待决会阻挡本次整体完成；源代码与父子关系保持不变，验收仍独立。',
        detail, confirmLabel: '开始整合', agent: true, confirmHelp: START_HELP });
      if (!confirmed || !current()) return;
      const result = await action('branch.integrate_start', { branch: task.branch, expected_revision: plan.revision }, { refresh: false });
      if (!current()) return;
      // An ACK is not a successful landing. Do not send another start on a refresh failure.
      accepted = result;
      if (!valid(result) || result.target_branch !== task.branch) {
        notice(root, '开始请求已返回，但操作身份未核对完整；请只读刷新核查，不要重复开始。', true); return;
      }
      root.append(integrationSummary({ merge_operation: result }));
      notice(root, '整合请求已确认；尚不表示代码已合入。');
      try { await refresh(); } catch (error) {
        if (current()) notice(root, `整合请求已确认，但页面刷新失败：${error.message}；请只读刷新，不要重复开始。`, true);
      }
    } catch (error) {
      if (current() && !isReadAbort(error)) notice(root, `整合未确认：${error.message}。请重新读取核查；不会自动重发。`, true);
    } finally {
      busy = false;
      if (current()) {
        control.disabled = Boolean(accepted || active);
        host.setAttribute('data-help', accepted ? '操作已存在；请查看整合 Worker 或只读刷新，不要重复开始。' : START_HELP);
      }
    }
  };
  return root;
}

/** The operation lives in its real Worker detail, not in another project management page. */
export function integrationDetails(task, { refresh = () => {}, ownsPage = () => true, signal } = {}) {
  if (task.execution_retired === true || task.task_kind !== 'integration' || !task.merge_operation) return null;
  const root = block('一次性整合'); root.classList.add('integration-details');
  const current = lifetime(root, ownsPage);
  let operation = task.merge_operation, busy = false, uncertain = false;
  function paint() {
    root.replaceChildren(el('h2', '一次性整合'));
    if (!valid(operation)) { root.append(el('p', '整合操作读面不完整，请刷新核查。', 'error')); return; }
    root.append(integrationSummary({ merge_operation: operation }));
    const list = el('ul', undefined, 'integration-sources'); list.setAttribute('aria-label', '本次固定来源');
    for (const member of operation.members) {
      const row = el('li'); row.append(linkWorker(member, `${workerLabel(member)} ${member.title || ''}`)); list.append(row);
    }
    root.append(list);
    if (operation.members_truncated) root.append(el('p', `已显示 ${operation.members.length} / ${operation.member_count} 个来源；摘要不代表完整范围，请读取完整来源。`, 'warn'));
    if (operation.state === 'integrated') root.append(el('p', `已实际合入 ${operation.target_branch} · ${operation.commit || '落地提交未返回，请核查'}；来源验收保持独立。`, 'integration-result'));
    else if (operation.state === 'withdrawn') root.append(el('p', '本次整合已取消；源代码和整合现场保留，未据此撤销任何已落地提交。', 'hint'));
    else root.append(el('p', '候选与工作完成不代表已经合入；实际适配和测试见本 Worker 的结果与执行过程。', 'hint'));
    const evidence = el('details', undefined, 'integration-evidence'); evidence.append(el('summary', '高级：固定提交与来源映射'));
    if (operation.baseline) evidence.append(el('p', `目标基线：${operation.baseline}`, 'mono'));
    if (operation.candidate_commit) evidence.append(el('p', `候选提交：${operation.candidate_commit}`, 'mono'));
    if (operation.commit) evidence.append(el('p', `落地提交：${operation.commit}`, 'mono'));
    for (const member of operation.members) evidence.append(el('p', `${workerLabel(member)} · 增量基点 ${member.base_commit || '未提供'} · 源 ${member.source_commit || '未提供'}`, 'mono'));
    root.append(evidence);
    const actions = el('div', undefined, 'actions integration-actions');
    const read = button(operation.members_truncated ? '读取完整来源与状态' : '刷新整合状态', async () => {
      if (!current() || busy) return;
      busy = true;
      try {
        const next = await scopedRead(`/api/branch-integration?id=${operation.id}`, signal);
        if (!current()) return;
        if (!valid(next) || next.id !== operation.id || next.target_branch !== operation.target_branch) throw Error('操作身份或来源读面不匹配');
        operation = next; uncertain = false; paint();
      } catch (error) { if (current() && !isReadAbort(error)) notice(root, `整合状态读取失败：${error.message}；保留已读记录。`, true); }
      finally { busy = false; }
    }, 'ghost'); actions.append(read);
    const mutate = (method, label, help, agent) => {
      const host = el('span', undefined, 'help-host'); host.setAttribute('data-help', help);
      const control = button(label, async () => {
        if (!current() || busy || uncertain) return;
        busy = true;
        try {
          const confirmed = await confirmDialog({ title: `${label}？`, message: help, confirmLabel: label, agent, confirmHelp: help });
          if (!confirmed || !current()) return;
          const result = await action(method, { id: operation.id, expected_revision: operation.revision }, { refresh: false });
          if (!current()) return;
          uncertain = true;
          if (!valid(result) || result.id !== operation.id || result.target_branch !== operation.target_branch) throw Error('请求已返回，但操作身份未核对完整；请只读刷新核查');
          operation = result; paint();
          try { await refresh(); } catch (error) { if (current()) notice(root, `请求已确认，但页面刷新失败：${error.message}；不要重复提交。`, true); }
        } catch (error) {
          if (current()) { uncertain = true; paint(); notice(root, `操作未确认：${error.message}；请先只读刷新核查，不会自动重发。`, true); }
        } finally { busy = false; }
      }, 'ghost', { agent, help });
      control.disabled = uncertain || operation.state === 'awaiting' && operation.worker?.status === 'awaiting' && method.endsWith('retry');
      if (control.disabled) { host.tabIndex = 0; host.setAttribute('data-help', uncertain ? '先只读刷新操作状态，避免重复提交。' : '请先处理此整合 Worker 的待决问题。'); }
      host.append(control); actions.append(host);
    };
    if (['failed', 'awaiting'].includes(operation.state)) mutate('branch.integrate_retry', '重试整合', agentHelp('核对固定来源和操作版本，在保留的整合 Worker 中重新适配并验证；不能重放未知落地，待决须先处理。'), true);
    if (['preparing', 'resolving', 'awaiting', 'ready', 'failed'].includes(operation.state)) mutate('branch.integrate_cancel', '取消本次整合', '停止尚未落地的整合，等待调用安全退出后释放来源；保留源代码与私有现场，不撤销已落地代码。', false);
    root.append(actions);
  }
  paint(); return root;
}
