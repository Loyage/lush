import { button, el } from './dom.js';

export const PROVIDERS = [['deepseek', 'DeepSeek'], ['openrouter', 'OpenRouter'], ['zai', 'Z.AI'], ['kimi-coding', 'Kimi Coding'], ['openai-codex', 'Codex 订阅'], ['openai-compatible', '自定义 OpenAI 兼容 API']];
export const SOURCES = { usage_api: '专用余额 / 额度接口', client_rpc: '原生客户端协议', response_headers: '正常模型响应（调用结束后采集）', none: '尚无观测来源' };
export const CREDENTIALS = { configured: '已配置（不代表已联网验证）', unconfigured: '未配置', expired: '已过期', unknown: '未知' };
export const STATUSES = { available: '观测成功', partial: '部分指标可用', unknown: '尚未取得当前数据', error: '查询失败（不代表资源耗尽）', unsupported: '此连接无法查询', unconfigured: '缺少查询凭证' };
export const SCOPES = { account: '账号共享', key: 'API Key 预算', model: '模型专属' };
export const array = value => Array.isArray(value) ? value : [];
export const text = (value, fallback = '未知') => typeof value === 'string' && value ? value : fallback;
export const finite = value => typeof value === 'number' && Number.isFinite(value);
export const amount = value => finite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 8 }) : '未知';
export const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '时间未知';
export const canQuery = connection => connection?.enabled && connection.provider !== 'openai-compatible'
  && (connection.credential?.status === 'configured' || connection.auth_type === 'oauth' && connection.credential?.status === 'expired');
export const publicConfig = connection => Object.fromEntries(['id', 'label', 'provider', 'endpoint', 'auth_type', 'enabled', 'models', 'default_model', 'default_thinking', 'notify_reset']
  .filter(key => connection[key] !== undefined).map(key => [key, connection[key]]));
export const successful = value => ['available', 'partial'].includes(value?.status);
export const note = (parent, value, warning = false) => parent.append(el('p', value, warning ? 'agent-status-warning' : 'hint'));

export function field(parent, label, key, type = 'text', value = '', help = '') {
  const wrap = el('label', label, 'agent-connection-field'), input = el('input');
  input.type = type; input.dataset.connectionField = key; input.setAttribute('aria-label', label);
  if (type === 'checkbox') input.checked = Boolean(value); else input.value = String(value ?? '');
  wrap.append(input); if (help) wrap.append(el('small', help, 'hint'));
  parent.append(wrap); return input;
}
export function select(parent, label, key, options, value = '') {
  const wrap = el('label', label, 'agent-connection-field'), input = el('select');
  input.dataset.connectionField = key; input.setAttribute('aria-label', label);
  for (const [id, name] of options) { const option = el('option', name); option.value = id; input.append(option); }
  input.value = value; wrap.append(input); parent.append(wrap); return input;
}
export function helped(label, fn, help, className = 'ghost') {
  const host = el('span', undefined, 'help-host'); if (help) host.setAttribute('data-help', help);
  host.append(button(label, fn, className, { help })); return host;
}
export function positive(input, max, name) {
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name}必须是 1–${max} 的整数。`);
  return value;
}
