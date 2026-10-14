import { el, badge } from './dom.js';
import { bindWorkerPreview } from './entity-preview.js';
import { workerLabel } from './worker-label.js';
import { statusOf } from './format.js';
import { projectBase } from './route.js';
import { deliveryHash, deliveryStage } from './delivery-model.js';

export function deliveryLink(label, hash, className = 'nav-link') {
  const link = el('a', label.replace(/\s*→$/, ''), className); link.href = `${projectBase()}/${hash}`; return link;
}
export function deliveryWorker(worker, label = '') {
  const text = label || `${worker.id ? workerLabel({ ...worker, worker_number: worker.worker_number ?? null }) : '身份未知'}${worker.title ? ` ${worker.title}` : ''}`;
  if (!worker.id || worker.missing || worker.identity_mismatch) return el('span', `${text} · ${worker.identity_mismatch ? '身份不符' : '记录缺失'}`, 'warn');
  const link = deliveryLink(text, `#worker-${worker.id}`); bindWorkerPreview(link, worker); return link;
}
export function deliveryWarnings(value) {
  const box = el('div', undefined, 'delivery-warnings');
  for (const [key, text] of [['missing', 'Worker 记录缺失'], ['identity_mismatch', '持久身份不符，不能解释为当前交付'],
    ['reservation_version_unknown', '预约损坏或版本未知'], ['reservation_truncated', '预约已截断，无法完整核对'],
    ['item_truncated', '条目超出读面预算，仅返回定位信息'], ['members_truncated', '来源成员截断，未展示全部来源'],
    ['nodes_truncated', '节点证据截断，未展示全部节点']]) if (value?.[key]) box.append(el('p', text, 'warn'));
  if (value?.integration_workers?.truncated) box.append(el('p', '整合身份引用截断，未展示全部 Worker', 'warn'));
  if (value?.unavailable_reason) box.append(el('p', value.unavailable_reason, 'hint'));
  return box;
}
export function deliveryInput(queue) {
  return `当前暂存输入：${queue?.buffered == null ? '未知' : `${queue.buffered} 条`}（已保存不表示 Agent 已收到）${queue?.reason ? ` · ${queue.reason}` : ''}`;
}
/** Always visible on minimal tree cards; points at this round, never the previous receipt. */
export function sourceDelivery(summary) {
  if (!summary) return null;
  const row = el('div', undefined, 'source-delivery');
  row.append(badge(deliveryStage(summary.stage, summary.version), summary.stage === 'integrated' ? 'b-completed' : 'b-awaiting'));
  for (const worker of summary.integration_workers?.items || []) {
    const prefix = worker.current === false ? '旧代整合' : ['completed','awaiting_acceptance'].includes(worker.status) ? '整合已交付' : worker.status === 'running' ? '整合中' : '等待整合';
    row.append(el('span', `${prefix} ${workerLabel({ ...worker, worker_number: worker.worker_number ?? null })} · ${worker.status ? statusOf(worker).label : '状态未知'}`), deliveryWarnings(worker));
  }
  if (summary.current === false) row.append(el('span', '非当前预约交付', 'warn'));
  if (['invalid','failed','blocked','awaiting','stale'].includes(summary.stage) && summary.waiting_reason) row.append(el('span', summary.waiting_reason, 'hint'));
  const queue = el('span', `暂存输入：${summary.input_queue?.buffered == null ? '未知' : `${summary.input_queue.buffered} 条`}`);
  queue.setAttribute('data-help', deliveryInput(summary.input_queue));
  row.append(queue, deliveryWarnings(summary),
    deliveryLink('定位本轮交付 →', deliveryHash(summary.locator, summary.stage === 'integrated')));
  return row;
}
