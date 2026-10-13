import { el } from './dom.js';
import { usageErrorLabels, usageWindow } from './format.js';
import { array, text, finite, amount, time, note, STATUSES, SOURCES, SCOPES, successful } from './connection-view-common.js';

/** 相对时长只是主显示，绝对时间保留在折叠详情；不把旧观测伪装成刚刚刷新。 */
export function relativeTime(value, now = Date.now()) {
  const at = Date.parse(value);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return '时间未知';
  const delta = now - at;
  if (delta < 0) return `约 ${Math.max(1, Math.ceil(-delta / 60000))} 分钟后`;
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return `${Math.floor(days / 30)} 个月前`;
}
export function resetRemaining(value, now = Date.now()) {
  const remaining = Date.parse(value) - now;
  if (!Number.isFinite(remaining)) return '重置时间未知';
  if (remaining <= 0) return '已到重置时间，待刷新';
  const minutes = Math.ceil(remaining / 60000);
  if (minutes < 60) return `约 ${minutes} 分钟后重置`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (hours < 24) return `约 ${hours} 小时${rest ? ` ${rest} 分钟` : ''}后重置`;
  return `约 ${Math.floor(hours / 24)} 天${hours % 24 ? ` ${hours % 24} 小时` : ''}后重置`;
}
/** 已用比例只从结构化字段推导，缺失时返回 null，绝不把未知当零。 */
const quotaPercent = resource => {
  if (finite(resource.used_percent)) return Math.max(0, Math.min(100, resource.used_percent));
  if (finite(resource.used) && finite(resource.total) && resource.total > 0) return Math.max(0, Math.min(100, resource.used / resource.total * 100));
  if (finite(resource.remaining) && finite(resource.total) && resource.total > 0) return Math.max(0, Math.min(100, (resource.total - resource.remaining) / resource.total * 100));
  return null;
};
const quotaLevel = percent => percent >= 85 ? 'is-high' : percent >= 60 ? 'is-mid' : 'is-low';
const shortWindow = seconds => {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return '窗口未知';
  for (const [unit, size] of [['d', 86400], ['h', 3600], ['m', 60]]) if (seconds % size === 0) return `${seconds / size}${unit}`;
  return `${seconds}s`;
};
const subscription = resource => resource.kind === 'quota' && resource.scope === 'account';
const resourceTitle = resource => subscription(resource) ? shortWindow(resource.window_seconds) : text(resource.label, resource.kind === 'balance' ? '现金' : 'Key / 模型额度');
function quotaBar(resource, percent) {
  const bar = el('div', undefined, `agent-quota-bar ${quotaLevel(percent)}`);
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', `${text(resource.label, '未命名指标')} 已用 ${amount(percent)}%`);
  bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', String(Math.round(percent)));
  const fill = el('div', undefined, 'agent-quota-fill');
  fill.style.width = `${Math.max(2, percent)}%`;
  bar.append(fill); return bar;
}

/** Render only structured public resources, never parse terminal output or infer quota from RPM headers. */
export function renderConnectionResources(observation = {}, { now = Date.now, reminder = false } = {}) {
  observation ||= {};
  const root = el('div', undefined, 'agent-connection-resources');
  note(root, STATUSES[observation.status] || '观测状态未知', !successful(observation));
  const refreshed = successful(observation);
  note(root, `来源：${SOURCES[observation.source] || '未知来源'} · ${refreshed ? '上次刷新' : '观测时间'}：${relativeTime(observation.checked_at, now())}`);
  // 主显示相对时长，绝对观测时间与来源收进折叠区，避免把旧值当成当前值。
  const when = el('details', undefined, 'agent-connection-observation-details');
  when.append(el('summary', '观测时间与来源'));
  note(when, `${refreshed ? '上次刷新' : '观测时间'}：${time(observation.checked_at)}`);
  note(when, `来源：${SOURCES[observation.source] || '未知来源'}`);
  root.append(when);
  if (observation.error_code) note(root, usageErrorLabels[observation.error_code] || '本次未取得完整资源数据；不能据此判断余额为零。', true);
  if (observation.reason) note(root, observation.reason);
  if (!successful(observation)) return root;
  if (!array(observation.resources).length) note(root, '暂无可展示指标，未知不等于零。', true);
  for (const resource of array(observation.resources)) {
    if (!['balance', 'quota'].includes(resource.kind)) continue;
    const entry = el('section', undefined, 'agent-connection-resource');
    const head = el('div', undefined, 'agent-connection-resource-head');
    head.append(el('h4', resourceTitle(resource)));
    if (!subscription(resource) && resource.kind === 'quota' && Number.isSafeInteger(resource.window_seconds) && resource.window_seconds > 0)
      head.append(el('span', usageWindow(resource.window_seconds), 'agent-connection-window'));
    entry.append(head);
    const percent = resource.kind === 'quota' ? quotaPercent(resource) : null;
    if (percent !== null) {
      const row = el('div', undefined, 'agent-quota-row');
      row.append(quotaBar(resource, percent), el('span', `${amount(percent)}%`, 'agent-quota-percent'));
      entry.append(row);
      if (finite(resource.remaining)) {
        const remaining = el('p', undefined, 'hint');
        remaining.append(el('strong', `剩余 ${amount(resource.remaining)} ${text(resource.unit, '单位未知')}`, 'model-source-key-amount')); entry.append(remaining);
      }
    } else {
      const remaining = el('p', undefined, 'agent-status-amount');
      remaining.append(el('strong', `剩余 ${amount(resource.remaining)} ${text(resource.unit, '单位未知')}`, 'model-source-key-amount')); entry.append(remaining);
    }
    if (resource.reset_at) {
      const reset = el('p', resetRemaining(resource.reset_at, now()), 'hint agent-reset-remaining');
      reset.dataset.resetAt = resource.reset_at;
      if (Date.parse(resource.reset_at) <= now()) reset.classList.add('is-due');
      if (reminder) reset.dataset.reminder = '1';
      entry.append(reset);
    }
    // 详细口径收进折叠区，主视图只留进度与关键时间，事实仍完整可读。
    const details = el('details', undefined, 'agent-connection-resource-details');
    details.append(el('summary', '指标说明与原始读数'));
    note(details, `指标：${text(resource.label, '未命名指标')}`);
    note(details, `${resource.kind === 'balance' ? '现金余额' : resource.scope === 'key' ? 'API Key 消费额度（非账户余额）' : '套餐 / API 额度（非现金余额）'} · ${SCOPES[resource.scope] || '范围未知'}`);
    if (finite(resource.total)) note(details, `总量 ${amount(resource.total)} ${text(resource.unit, '单位未知')}`);
    if (finite(resource.used)) note(details, `已用 ${amount(resource.used)} ${text(resource.unit, '单位未知')}`);
    if (finite(resource.used_percent)) note(details, `已用比例 ${amount(resource.used_percent)} %`);
    if (resource.kind === 'quota') note(details, usageWindow(resource.window_seconds));
    if (resource.reset_at) note(details, `重置时间：${time(resource.reset_at)}`);
    if (resource.unit === '%') note(details, '百分比不是实际 token、请求总量或金额。');
    if (array(resource.models).length) note(details, `适用模型：${resource.models.join('、')}`);
    entry.append(details);
    root.append(entry);
  }
  return root;
}

/** Bounded overview: never expand raw resources, old values or consumers into the list. */
export function renderResourceSummary(observation = {}, now = Date.now()) {
  observation ||= {};
  const root = el('div', undefined, 'model-source-resource-summary');
  if (observation.status !== 'available') note(root, STATUSES[observation.status] || '观测状态未知', !successful(observation));
  const resources = successful(observation) ? array(observation.resources).filter(resource => ['balance', 'quota'].includes(resource.kind)) : [];
  for (const resource of resources.slice(0, 2)) {
    const percent = resource.kind === 'quota' ? quotaPercent(resource) : null;
    const kind = resource.kind === 'balance' ? '现金' : resource.scope === 'key' ? 'Key 预算' : '套餐 / 额度';
    const window = resource.kind === 'quota' && !subscription(resource) && resource.window_seconds > 0 ? ` · ${shortWindow(resource.window_seconds)}` : '';
    const entry = el('div', undefined, 'model-source-resource-item');
    const value = el('p', `${subscription(resource) ? resourceTitle(resource) : `${text(resource.label, kind)}（${kind}${window}）`}：`, 'hint');
    value.append(el('strong', percent !== null ? `已用 ${amount(percent)}%` : `剩余 ${amount(resource.remaining)} ${text(resource.unit, '单位未知')}`, 'model-source-key-amount'));
    if (percent !== null && finite(resource.remaining)) value.append(el('strong', ` · 剩余 ${amount(resource.remaining)} ${text(resource.unit, '单位未知')}`, 'model-source-key-amount'));
    entry.append(value);
    if (percent !== null) entry.append(quotaBar(resource, percent));
    if (resource.kind === 'quota') {
      const reset = el('p', resetRemaining(resource.reset_at, now), 'model-source-reset-time');
      reset.dataset.resetAt = resource.reset_at || '';
      reset.classList.toggle('is-due', Date.parse(resource.reset_at) <= now);
      entry.append(reset);
    }
    root.append(entry);
  }
  if (successful(observation) && !resources.length) note(root, '暂无指标；未知不等于零。', true);
  if (resources.length > 2) {
    const extra = `另 ${resources.length - 2} 项见详情`;
    if (observation.status !== 'available') root.children[0].textContent += ` · ${extra}`;
    else note(root, extra);
  }
  return root;
}
