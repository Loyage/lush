import { block, button, el } from './dom.js';

const list = value => Array.isArray(value) ? value : [];
export const defaultUsageConfig = () => ({ version: 1, enabled: false, interval_minutes: 5, retention_days: 90, providers: [], custom: [] });
const note = (parent, text) => parent.append(el('p', text, 'hint'));
function field(parent, label, value = '', { type = 'text', placeholder = '', choices = null, key = '', change = () => {} } = {}) {
  const wrap = el('label', label, 'agent-usage-field');
  const input = el(choices ? 'select' : type === 'textarea' ? 'textarea' : 'input');
  if (choices) for (const [id, text] of choices) { const option = el('option', text); option.value = id; input.append(option); }
  else if (type !== 'textarea') input.type = type;
  input.value = value ?? ''; input.placeholder = placeholder; input.setAttribute('aria-label', label);
  if (key) input.setAttribute('data-field', key);
  input.oninput = change; input.onchange = change;
  wrap.append(input); parent.append(wrap); return input;
}
function removeButton(label, fn) {
  return button(label, fn, 'agent-usage-remove', { help: '从尚未保存的配置中移除此项；保存后生效，已缓存历史不会删除。' });
}
function int(value, min, max, label) {
  if (!/^\d+$/.test(String(value)) || Number(value) < min || Number(value) > max) throw new Error(`${label}须为 ${min}–${max} 的整数。`);
  return Number(value);
}
function required(input, label) { const value = input.value.trim(); if (!value) throw new Error(`请填写${label}。`); return value; }
const optional = input => input.value.trim() || null;

function metricEditor(value, changed, remove) {
  const node = el('fieldset', undefined, 'agent-usage-metric'), fields = {};
  node.append(el('legend', '额度 / 余额指标'));
  const grid = el('div', undefined, 'agent-usage-grid');
  for (const [key, label, placeholder] of [
    ['id', '指标 ID', 'remaining'], ['label', '指标名称', '周额度'], ['unit', '单位', '% / USD / 请求'],
    ['remaining', '剩余量字段路径', 'data.remaining'], ['total', '总量字段路径', 'data.limit'], ['used', '已用量字段路径', 'data.used'],
    ['reset_at', '重置时间字段路径', 'data.reset_at'], ['window_seconds', '额度窗口（秒，可空）', '604800'],
  ]) fields[key] = field(grid, label, value[key], { key, placeholder, change: changed, type: key === 'window_seconds' ? 'number' : 'text' });
  node.append(grid, removeButton('移除指标', remove));
  return { node, read() {
    const item = { id: required(fields.id, '指标 ID'), label: required(fields.label, '指标名称'), unit: required(fields.unit, '单位') };
    for (const key of ['remaining', 'total', 'used', 'reset_at']) item[key] = optional(fields[key]);
    if (!item.remaining && !item.total && !item.used) throw new Error('每个指标至少填写一个数值字段路径。');
    item.window_seconds = optional(fields.window_seconds) === null ? null : int(fields.window_seconds.value, 1, 315360000, '额度窗口');
    return item;
  } };
}

function sourceEditor(value, changed, remove) {
  const node = el('fieldset', undefined, 'agent-usage-source'); node.append(el('legend', '自定义 HTTP 查询'));
  const grid = el('div', undefined, 'agent-usage-grid');
  const provider = field(grid, '服务商 ID', value.provider, { key: 'provider', placeholder: 'my-provider', change: changed });
  const label = field(grid, '查询名称', value.label, { key: 'label', placeholder: '我的额度接口', change: changed });
  const url = field(grid, 'HTTPS 查询地址', value.url, { key: 'url', type: 'url', placeholder: 'https://example.com/api/usage', change: changed });
  const method = field(grid, '请求方法', value.method || 'GET', { key: 'method', choices: [['GET', 'GET'], ['POST', 'POST']], change: changed });
  const kind = field(grid, '数值类型', value.kind || 'quota', { key: 'kind', choices: [['quota', '订阅 / API 额度（非现金）'], ['balance', '现金余额']], change: changed });
  node.append(grid);
  note(node, '仅访问你信任的 HTTPS 地址；自定义查询会覆盖该服务商的内置查询。配置后还须将服务商 ID 加入上方查询范围（当前服务商除外）。');
  const headersNode = el('div', undefined, 'agent-usage-headers'), headers = [];
  headersNode.append(el('h4', '请求头'));
  const addHeader = (key = '', value = '') => {
    const row = el('div', undefined, 'agent-usage-header-row');
    const name = field(row, '请求头名称', key, { key: 'header-name', placeholder: 'Authorization', change: changed });
    const input = field(row, '请求头值 / 环境引用', value, { key: 'header-value', placeholder: 'Bearer ${MY_API_KEY}', change: changed });
    const entry = { row, name, input };
    row.append(removeButton('移除请求头', () => { headers.splice(headers.indexOf(entry), 1); row.remove(); changed(); }));
    headers.push(entry); headersNode.append(row);
  };
  for (const [key, val] of Object.entries(value.headers || {})) addHeader(key, val);
  node.append(headersNode, button('添加请求头', () => { if (headers.length >= 20) throw new Error('最多配置 20 个请求头。'); addHeader(); changed(); }));
  const body = field(node, 'POST 请求体（JSON 模板，可空）', value.body || '', { key: 'body', type: 'textarea', placeholder: '{"token":"${MY_API_KEY}"}', change: changed });
  note(node, '密钥只写 ${ENV_NAME} 引用，在 daemon 的公共 / agent 环境配置中设置；不要把明文密钥填入地址、请求头或请求体。不会自动转发 Pi 凭证，不支持脚本。GET 请求体必须留空。');
  const metricsNode = el('div', undefined, 'agent-usage-metrics'), metrics = [];
  const addMetric = data => {
    if (metrics.length >= 10) throw new Error('每个查询最多配置 10 个指标。');
    const metric = metricEditor(data, changed, () => { metrics.splice(metrics.indexOf(metric), 1); metric.node.remove(); changed(); });
    metrics.push(metric); metricsNode.append(metric.node);
  };
  for (const item of list(value.items)) addMetric(item);
  node.append(metricsNode, button('添加指标', () => { addMetric({}); changed(); }), removeButton('移除此查询', remove));
  note(node, '字段路径示例：data.remaining、limits.0.remaining。未知值不会补零；总量与已用量可推导剩余量。百分比请明确使用 %，不自动猜测小数尺度。');
  return { node, read() {
    const providerId = required(provider, '服务商 ID');
    if (!/^[a-z][a-z0-9_-]{0,79}$/i.test(providerId)) throw new Error('服务商 ID 只能使用字母、数字、下划线和连字符，以字母开头。');
    let address; try { address = new URL(required(url, 'HTTPS 查询地址')); } catch { throw new Error('请填写有效的 HTTPS 查询地址。'); }
    if (address.protocol !== 'https:' || address.username || address.password || address.hash || url.value.includes('${')) throw new Error('查询地址必须是 HTTPS，不能包含用户密码、片段或环境插值。');
    const mappedHeaders = Object.create(null);
    for (const header of headers) {
      const key = required(header.name, '请求头名称');
      if (Object.keys(mappedHeaders).some(existing => existing.toLowerCase() === key.toLowerCase())) throw new Error('请求头名称不能重复。');
      mappedHeaders[key] = header.input.value;
    }
    const jsonBody = body.value.trim() || null;
    if (method.value === 'GET' && jsonBody) throw new Error('GET 请求体必须留空。');
    if (jsonBody) { try { JSON.parse(jsonBody); } catch { throw new Error('POST 请求体须为有效 JSON 文本；环境引用应放在 JSON 字符串中。'); } }
    const items = metrics.map(metric => metric.read());
    if (!items.length) throw new Error('每个自定义查询至少需要一个指标。');
    if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('同一查询中的指标 ID 不能重复。');
    return { provider: providerId, label: required(label, '查询名称'), url: url.value.trim(), method: method.value,
      headers: mappedHeaders, body: jsonBody, kind: kind.value, items };
  } };
}

/** Editable controls have one lifetime; callers never replace a dirty form after a read response. */
export function usageConfigForm(config, accounts, { changed, save }) {
  const node = block('查询与采样设置'), form = el('form', undefined, 'agent-usage-form');
  const controls = el('fieldset', undefined, 'agent-usage-controls'); controls.append(el('legend', '项目用量配置'));
  const general = el('div', undefined, 'agent-usage-grid');
  const enabledLabel = el('label', undefined, 'agent-usage-toggle'), enabled = el('input');
  enabled.type = 'checkbox'; enabled.checked = Boolean(config.enabled); enabled.setAttribute('data-field', 'enabled'); enabled.setAttribute('aria-label', '启用后台定时采样');
  enabled.onchange = changed; enabledLabel.append(enabled, el('span', '启用后台定时采样')); general.append(enabledLabel);
  const interval = field(general, '采样间隔（分钟）', config.interval_minutes, { key: 'interval_minutes', type: 'number', change: changed });
  interval.min = '1'; interval.max = '1440';
  const retention = field(general, '历史保留（天）', config.retention_days, { key: 'retention_days', type: 'number', change: changed });
  retention.min = '1'; retention.max = '3650';
  controls.append(general);
  note(controls, '默认只在进入状态页或手动刷新时联网查询。启用后台采样后，关闭页面仍会查询；daemon 停止期间没有样本，也不会补发。查询不会调用 Agent 或模型。');
  note(controls, '超过保留期限的样本会自动清理，缩短期限可能永久删除旧历史；保存配置不会立即执行远端查询。');
  const providers = field(controls, '查询服务商（逗号分隔，留空仅当前 Agent 服务商）', list(config.providers).join(', '), { key: 'providers', placeholder: 'openai-codex, deepseek', change: changed });
  const choices = [...new Set([...list(accounts).map(account => account.provider), ...list(config.custom).map(source => source.provider)].filter(Boolean))].sort();
  if (choices.length) {
    const chooser = el('div', undefined, 'agent-usage-provider-chooser');
    const choice = field(chooser, '已发现的服务商', choices[0], { choices: choices.map(id => [id, id]) });
    chooser.append(button('加入查询范围', () => { providers.value = [...new Set([...providers.value.split(/[\s,，]+/).filter(Boolean), choice.value])].join(', '); changed(); }));
    controls.append(chooser);
  }
  const sourcesNode = el('div', undefined, 'agent-usage-sources'), sources = [];
  const addSource = value => {
    if (sources.length >= 20) throw new Error('最多配置 20 个自定义查询。');
    const source = sourceEditor(value, changed, () => { sources.splice(sources.indexOf(source), 1); source.node.remove(); changed(); });
    sources.push(source); sourcesNode.append(source.node);
  };
  for (const source of list(config.custom)) addSource(source);
  controls.append(sourcesNode, button('添加自定义查询', () => { addSource({ items: [{}] }); changed(); }));
  const saveButton = button('保存查询设置', () => save(read()), 'agent-usage-save');
  form.append(controls, saveButton); form.onsubmit = event => { event.preventDefault(); return saveButton.onclick(); };
  node.append(form);
  function read() {
    const selected = [...new Set(providers.value.split(/[\s,，]+/).filter(Boolean))];
    if (selected.length > 20) throw new Error('最多选择 20 个服务商。');
    if (selected.some(id => !/^[a-z][a-z0-9_-]{0,79}$/i.test(id))) throw new Error('查询服务商 ID 格式不正确。');
    const custom = sources.map(source => source.read());
    if (new Set(custom.map(source => source.provider)).size !== custom.length) throw new Error('同一服务商只能配置一个自定义查询。');
    return { version: 1, enabled: enabled.checked, interval_minutes: int(interval.value, 1, 1440, '采样间隔'),
      retention_days: int(retention.value, 1, 3650, '保留期限'), providers: selected, custom };
  }
  return { node, read, busy(value) { controls.disabled = value; saveButton.disabled = value; } };
}
