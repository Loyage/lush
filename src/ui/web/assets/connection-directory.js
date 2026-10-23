import { block, button, el, kv } from './dom.js';
import { listEntry } from './list-surface.js';
import { diagnosticsLink } from './diagnostics-route.js';
import { pageBlocks } from './page-modules.js';
import { workerLabel } from './worker-label.js';
import { PROVIDERS, CREDENTIALS, array, text, time, field, note, helped, canQuery, successful } from './connection-view-common.js';
import { renderResourceSummary, renderConnectionResources, relativeTime } from './connection-resources.js';

/** Public-data views; selection, focus and mutations stay with the page owner. */
export function renderConnectionRow(connection, { selected, refreshing, operation, now, onSelect, onQuery, onDetail }) {
  const row = listEntry(el('article', undefined, 'model-source-row')); row.dataset.sourceId = connection.id;
  const identity = el('div', undefined, 'model-source-identity');
  const check = field(identity, text(connection.label, '未命名来源'), 'select-source', 'checkbox', selected);
  check.setAttribute('aria-label', `选择 ${connection.label}`);
  check.onchange = () => onSelect(check.checked);
  identity.append(el('span', `${PROVIDERS.find(([id]) => id === connection.provider)?.[1] || connection.provider} · ${connection.enabled ? '启用' : '停用'}`, 'model-source-meta'));
  const storageScope = connection.storage_scope || (typeof connection.scope === 'string' ? connection.scope : null);
  if (storageScope === 'device' || storageScope === 'project') {
    const badge = el('span', storageScope === 'device' ? '设备共享来源' : '本项目来源', 'badge b-neutral'); badge.dataset.sourceScope = storageScope; identity.append(badge);
  }
  const settings = el('div', undefined, 'model-source-settings');
  note(settings, `默认模型：${connection.default_model || '未设置'}`);
  note(settings, `${connection.auth_type === 'oauth' ? 'OAuth 登录' : 'API Key'} · ${CREDENTIALS[connection.credential?.status] || '凭证未知'}`);
  settings.children[1].setAttribute('data-help', CREDENTIALS[connection.credential?.status] || '本地凭证状态未知；请打开详情检查。');
  const resources = renderResourceSummary(connection.observation, now());
  const actions = el('div', undefined, 'model-source-row-actions');
  const refreshRow = el('div', undefined, 'model-source-refresh-row');
  const refresh = helped(refreshing ? '刷新中…' : '刷新', onQuery,
    !canQuery(connection) ? '此来源未启用、缺少本地凭证或不支持额度查询；请到详情检查。' : null);
  refresh.children[0].disabled = !canQuery(connection) || refreshing;
  const cache = el('span', `上次刷新：${relativeTime(connection.observation?.checked_at, now())}`, 'model-source-cache-time');
  cache.setAttribute('data-help', `缓存观测（非实时）；观测时间：${time(connection.observation?.checked_at)}。查询失败不代表余额为零。`);
  refreshRow.append(cache, refresh); actions.append(refreshRow);
  const status = el('p', operation || '', 'hint model-source-operation'); status.setAttribute('role', 'status'); status.hidden = !status.textContent; actions.append(status);
  actions.append(diagnosticsLink(el, { connection_id: connection.id }), button('详情', onDetail, 'ghost model-source-details-toggle'));
  row.append(identity, settings, resources, actions); return row;
}

export function renderConnectionCard(connection, { now, projectHistory, actions }) {
  const card = el('article', undefined, 'agent-connection-card'); card.dataset.connectionId = connection.id;
  card.append(el('h3', text(connection.label, '未命名连接')));
  const connectionSection = block('连接与模型'), resourceSection = block('余额与额度'), consumerSection = block('使用情况');
  const grid = el('div', undefined, 'grid');
  grid.append(kv('服务商', text(connection.provider)), kv('模型端点', text(connection.endpoint)), kv('连接 ID', connection.id),
    kv('认证', connection.auth_type === 'oauth' ? 'OAuth 登录' : 'API Key'), kv('本地凭证', CREDENTIALS[connection.credential?.status] || '未知'),
    kv('连接状态', connection.enabled ? '启用' : '停用'));
  const defaults = [connection.default_model, connection.default_thinking].filter(Boolean).join(' · ');
  if (defaults) grid.append(kv('默认设定（运行设置快速填入）', defaults));
  if (connection.credential?.identity) grid.append(kv('账号身份（脱敏）', connection.credential.identity));
  if (connection.credential?.expires_at) grid.append(kv('凭证到期', time(connection.credential.expires_at)));
  connectionSection.append(grid);
  note(connectionSection, '密钥由 Lush 设备设置管理，存放在严格权限的私有文件中，不提供静态加密；系统当前用户仍可读取。托管来源可供 Pi 使用，Codex CLI 仍沿用自身认证；托管 Codex 登录不代表 Codex CLI 支持绑定。');
  note(connectionSection, '查询、登录和采样均不调用 Agent 或模型；不自动切换模型，也不自动转用付费资源。');
  note(connectionSection, `额度刷新提醒：${connection.notify_reset === true ? '开启（页面内）' : '关闭'}`);
  note(connectionSection, `模型列表：${array(connection.models).length ? connection.models.join('、') : '尚未填写；点击“编辑”添加，提交工作指令时即可从列表选择（留空不限制模型范围）'}`);
  if (array(connection.models).length) note(connectionSection, '由用户填写，供 Worker 运行设置选择；同时限制此来源的模型范围，不代表已联网验证可用。');
  if (connection.provider === 'openai-compatible') note(connectionSection, '自定义 OpenAI Chat Completions 兼容 API；余额查询尚不支持，不代表余额为零。运行时仅供 Pi 显式绑定，不自动切换账号。当前适配按文本/工具调用配置；32K 上下文、4K 输出是本地运行预算，不是已验证的上游限额或价格。');
  note(resourceSection, '以下为缓存观测，不保证当前仍有额度；窗口到期或账号变化后需重新查询。');
  resourceSection.append(renderConnectionResources(connection.observation, { now, reminder: connection.notify_reset === true }));
  const previous = connection.last_success;
  if (!successful(connection.observation) && previous) {
    const old = previous.observation || previous;
    if (successful(old)) {
      const stale = el('div', undefined, 'agent-connection-last-success');
      note(stale, `上次成功：${time(previous.checked_at || old.checked_at)}。以下为缓存旧值，不是当前资源状态。`, true);
      stale.append(renderConnectionResources(old, { now })); resourceSection.append(stale);
    }
  }
  const consumers = el('div', undefined, 'agent-connection-consumers');
  note(consumers, '实际正在使用此连接的本项目 Worker：');
  for (const consumer of array(connection.consumers)) {
    if (!Number.isSafeInteger(consumer.task_id) || consumer.task_id <= 0) continue;
    const link = el('a', `Worker ${workerLabel(consumer.task_id, consumer.task_worker_number)}`); link.href = `#worker-${consumer.task_id}`;
    consumers.append(link, el('span', ` · ${text(consumer.model)} `));
  }
  if (!array(connection.consumers).length) note(consumers, '暂无运行中的显式绑定；不猜测其他客户端消耗。');
  if (projectHistory) consumerSection.append(consumers);
  else note(consumerSection, '设备来源页不显示项目实际消费者或历史；请到来源项目查看，不推测其它项目与客户端的消耗。');
  card.append(connectionSection, resourceSection, consumerSection, actions);
  pageBlocks(card, `model-source-${connection.id}`, 'preview', section => [...section.querySelectorAll('.agent-status-warning')].map(node => node.textContent).join('；'));
  return card;
}
