import { el, badge } from './dom.js';
import { absolute } from './format.js';
import { workerLabel } from './worker-label.js';
import { bindWorkerPreview } from './entity-preview.js';

export const CONVERGENCE_STATES = {
  preparing: '归并中', resolving: '整合中', awaiting: '等待决定', validating: '验证中', ready: '等待落地',
  landing: '发布中', integrated: '已合并', failed: '失败', blocked: '落地待核查', withdrawn: '已撤回', stale: '已失效',
};
const VALIDATION_STATES = {
  pending: '等待验证', waiting: '等待验证', running: '验证中', validating: '验证中',
  succeeded: '通过', passed: '通过', pass: '通过', failed: '失败', fail: '失败',
  blocked: '验证受阻', not_started: '尚未执行', unknown: '结果未知', cancelled: '已中断',
};
const positive = value => Number.isSafeInteger(value) && value > 0;
const string = value => typeof value === 'string' && value.length > 0;
function workerLink(row, prefix = '') {
  const link = el('a', `${prefix}${workerLabel(row)}${row.title ? ` · ${row.title}` : ''}`, 'convergence-worker-link');
  link.href = `#worker-${row.id}`; link.setAttribute('href', link.href); bindWorkerPreview(link, row); return link;
}

/** Retained historical evidence only; never offers retry or configuration. */
export function renderConvergenceRun(run) {
  const card = el('article', undefined, 'hook-mount convergence-run'); card.dataset.runId = String(run.id);
  const head = el('div', undefined, 'hook-mount-head');
  head.append(el('strong', `历史归并批次 ${run.id}`), badge(Object.hasOwn(CONVERGENCE_STATES, run.state) ? CONVERGENCE_STATES[run.state] : `未知阶段：${run.state ?? '未提供'}`,
    run.state === 'integrated' ? 'b-completed' : ['failed', 'blocked', 'awaiting'].includes(run.state) ? 'b-awaiting' : 'b-neutral'));
  card.append(head, el('p', `目标：${run.target_branch} · ${Number.isSafeInteger(run.member_count) && run.member_count >= 0 ? run.member_count : '未知数量的'} 项成果 · ${absolute(run.updated_at || run.created_at)}`, 'hint'));
  const members = el('ul', undefined, 'convergence-members');
  for (const row of Array.isArray(run.members) ? run.members : []) {
    if (!positive(row?.id)) continue;
    const item = el('li'); item.append(workerLink(row)); members.append(item);
  }
  card.append(members);
  if (!Array.isArray(run.members)) card.append(el('p', '成员摘要尚未提供，不能推断完整历史范围。', 'hint'));
  if (run.members_truncated) card.append(el('p', '成员摘要已截断，不能据此推断完整历史范围。', 'hint'));
  if (run.error) card.append(el('p', run.error, 'error convergence-run-error'));
  if (run.state === 'blocked') card.append(el('p', '父侧落地结果需核查；不能通过重试盲目重放。', 'error'));
  if (run.validation) {
    card.append(el('p', `最终验证：${run.validation.command_name || '名称未知'} · ${Object.hasOwn(VALIDATION_STATES, run.validation.state) ? VALIDATION_STATES[run.validation.state] : `未知状态：${run.validation.state ?? '未提供'}`}`, 'convergence-validation'));
    if (run.validation.started_at || run.validation.finished_at) card.append(el('p', `开始 ${absolute(run.validation.started_at)} · 结束 ${absolute(run.validation.finished_at)}`, 'hint'));
    if (run.validation.error) card.append(el('p', run.validation.error, 'error'));
  } else card.append(el('p', '没有最终验证快捷指令记录，不代表测试通过。', 'hint'));
  if (positive(run.integration_worker?.id)) card.append(workerLink(run.integration_worker, '整合 Worker：'));
  const sources = (Array.isArray(run.members) ? run.members : []).filter(row => positive(row?.id) && string(row.source_commit));
  if (run.baseline || run.commit || sources.length) {
    const evidence = el('details', undefined, 'convergence-evidence'); evidence.append(el('summary', '固定提交'));
    if (run.baseline) evidence.append(el('p', `父基线：${run.baseline}`, 'convergence-sha'));
    if (run.commit) evidence.append(el('p', `${run.state === 'integrated' ? '落地提交' : '候选提交（尚未确认落地）'}：${run.commit}`, 'convergence-sha'));
    for (const row of sources) evidence.append(el('p', `成员 ${workerLabel(row)} · 历史交付 ${positive(row.delivery_id) || string(row.delivery_id) ? row.delivery_id : '编号未知'} · 源提交：${row.source_commit}`, 'convergence-sha'));
    card.append(evidence);
  }
  return card;
}

/** Compatibility for retired component callers: no reads, settings or side effects. */
export function renderBranchConvergence() {
  const node = el('p', '持续归并设置已退役；普通自动合并与已有历史保留。', 'hint');
  node.ready = Promise.resolve();
  return node;
}
