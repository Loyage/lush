import { block, el, pageModules } from './dom.js';
import { renderConnectionResources } from './connection-resources.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
export const amount = value => finite(value) ? value.toLocaleString(undefined, value !== 0 && Math.abs(value) < 0.01
  ? { maximumSignificantDigits: 3 } : { maximumFractionDigits: 2 }) : '未知';
const time = value => value ? new Date(value).toLocaleString() : '未知时间';
const percent = value => finite(value) ? `${amount(value * 100)}%` : '未知';
const source = (id, names) => names.get(id) || (id ? `历史来源 ${id}` : '未知来源 @unknown');
const svg = (tag, attrs = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

/** Safe SVG, with explicit breaks; null never becomes zero and no cross-series totals. */
function chart(points, lines, label) {
  const figure = el('figure', undefined, 'diagnostic-chart');
  figure.append(el('figcaption', label));
  const image = svg('svg', { viewBox: '0 0 600 160', role: 'img', 'aria-label': label });
  const values = points.flatMap(point => lines.map(line => point[line.key])).filter(finite);
  if (!values.length) { figure.append(el('p', '无可用观测；未知不补零', 'hint')); return figure; }
  const min = Math.min(0, ...values), max = Math.max(0, ...values) || 1, start = Date.parse(points[0].at), end = Date.parse(points.at(-1).at);
  image.append(svg('line', { x1: 12, x2: 588, y1: 142, y2: 142, class: 'diagnostic-axis' }));
  for (const [index, line] of lines.entries()) {
    let previous = null;
    for (const point of points) {
      const value = point[line.key];
      if (!finite(value) || point.status && !['available', 'partial'].includes(point.status)) { previous = null; continue; }
      const x = 12 + (end > start ? (Date.parse(point.at) - start) / (end - start) : 0.5) * 576;
      const y = 142 - (value - min) / (max - min) * 124;
      // Quota differences explicitly certify continuity. Resets/failures/sampling break it.
      if (previous && !point.reset && (!line.quota || finite(point.remaining_change))) image.append(svg('line', {
        x1: previous.x, y1: previous.y, x2: x, y2: y, class: `diagnostic-line diagnostic-series-${index}`,
      }));
      const dot = svg('circle', { cx: x, cy: y, r: 3, class: `diagnostic-dot diagnostic-series-${index}` });
      const title = svg('title'); title.textContent = `${time(point.at)} · ${line.label} ${amount(value)}${point.reset ? ' · 可能重置／充值，断开' : ''}`;
      dot.append(title); image.append(dot); previous = { x, y };
    }
  }
  figure.append(image, el('p', `${time(points[0].at)} → ${time(points.at(-1).at)} · 纵轴 ${amount(min)}–${amount(max)}`, 'hint'));
  const legend = el('div', undefined, 'diagnostic-legend');
  lines.forEach((line, index) => legend.append(el('span', line.label, `diagnostic-series-${index}`))); figure.append(legend);
  return figure;
}

export function renderDiagnostics(root, data, names = new Map()) {
  const { summary: s, coverage: c, quota: q } = data;
  const lower = c.usage_complete !== true;
  const coverage = el('section', undefined, 'diagnostic-coverage'); coverage.setAttribute('aria-label', '数据覆盖');
  coverage.append(el('p', `结果范围：${time(data.range.from)} → ${time(data.range.to)}（结束时刻不含） · 生成于 ${time(data.generated_at)}`));
  coverage.append(el('p', `${lower ? '覆盖不完整：已知用量／估价小计是下界；0 也不代表确认无消耗。' : '已采集用量覆盖完整。'} 速度仅代表有效样本，不是下界。`));
  coverage.append(el('p', `已采集 ${c.samples} 响应 / ${c.runs} 调用 · 未知调用 ${c.unknown_runs} · 丢弃样本 ${c.dropped_samples} · ${c.truncated ? '结果已截断' : '未截断'} · 未知用量 ${s.unknown_usage} / 估价 ${s.unknown_cost} 响应`));
  coverage.append(el('p', `文本计时 ${s.text_samples} 样本 / ${percent(c.text_coverage)} · 响应计时 ${s.response_samples} 样本 / ${percent(c.response_coverage)}（占已采集响应，不含未知调用中的缺失响应）`));
  coverage.append(el('p', '调用退出后入库，非逐 token 实时；未结束、旧记录和不支持的后端仍可能未知。旧会话不自动回填（legacy_backfill:false）。输入含缓存，暂无独立缓存数值。'));
  if (c.projects_total !== undefined) coverage.append(el('p', `项目覆盖 ${c.projects_reporting}/${c.projects_total}${c.projects_total === 0 ? ' · 无已登记项目，仅本地配置；没有运行数据覆盖' : ''}`));
  for (const project of data.projects || []) if (project.state !== 'online') coverage.append(el('p', `${project.name} · ${{ offline: '离线', unavailable: '不可用', unsupported: '旧版本／不支持' }[project.state] || project.state} · 不补零`));
  const metrics = el('div', undefined, 'diagnostic-metrics');
  for (const [label, value, note] of [
    ['输入 token', s.input_tokens, lower ? '已知下界 · 含缓存' : '含缓存'], ['输出 token', s.output_tokens, lower ? '已知下界' : '已知小计'],
    ['平均文本速度', s.text_chars_per_second, `字符/秒 · ${s.text_samples} 样本；响应 ${amount(s.response_tokens_per_second)} token/s · ${s.response_samples} 样本`],
    ['响应数', s.requests, '已采集 assistant 响应'], ['估算 USD', s.estimated_cost_usd, `${lower ? '已知下界 · ' : ''}非账单`],
  ]) { const card = el('div'); card.append(el('span', label), el('strong', amount(value)), el('small', note)); metrics.append(card); }
  const flow = block('输入／输出流量趋势');
  flow.append(el('p', '已知 token ÷ 墙钟秒数，不是模型吐字速度；缺口无法定位到桶时，所有桶均继承上方覆盖警告。', 'hint'),
    chart(data.buckets.map(bucket => lower ? { ...bucket,
      input_per_second: bucket.input_per_second > 0 ? bucket.input_per_second : null,
      output_per_second: bucket.output_per_second > 0 ? bucket.output_per_second : null } : bucket),
    [{ key: 'input_per_second', label: '输入 token/s' }, { key: 'output_per_second', label: '输出 token/s' }], '所选时间内的墙钟吞吐（缺失覆盖的零小计留空）'));
  const speed = block('来源与具体模型速度比较');
  speed.append(el('p', '可观测连续文本片段字符/秒；响应 token/s 包含等待与思考，不含工具执行／空闲。按分子、分母汇总，不平均各组速率。', 'hint'));
  if (!data.groups.length) speed.append(el('p', '暂无已采集来源／具体模型响应，速度未知。'));
  const max = Math.max(0, ...data.groups.map(group => group.text_chars_per_second).filter(finite)) || 1;
  for (const group of data.groups) {
    const row = el('article', undefined, 'diagnostic-speed-row');
    row.append(el('h3', `${source(group.connection_id, names)} · ${group.model || '未知模型 @unknown'}`));
    const bar = el('div', undefined, 'diagnostic-speed-track');
    if (finite(group.text_chars_per_second)) { const fill = el('span'); fill.style.width = `${Math.max(0, group.text_chars_per_second / max * 100)}%`; bar.append(fill); }
    row.append(bar, el('p', `文本 ${amount(group.text_chars_per_second)} 字符/秒（${group.text_samples}/${group.requests} 样本） · 响应 ${amount(group.response_tokens_per_second)} token/s（${group.response_samples}/${group.requests} 样本）`),
      el('p', `首有效 delta 等待 ${amount(group.wait_mean_ms)} ms（${group.wait_samples} 样本） · 首文本等待 ${amount(group.ttft_mean_ms)} ms（${group.ttft_samples} 样本）`, 'hint'));
    speed.append(row);
  }
  const quota = block('额度观测变化');
  quota.append(el('p', '来源共享额度：模型筛选不适用于额度。每个项目／来源／账号段／单位／窗口独立展示，不跨系列相加。剩余量变化 = 本次减上次观测，可能含外部消费，不是 Lush 消费。', 'diagnostic-quota-note'));
  quota.append(el('p', `${q.truncated ? '额度历史已截断。' : ''}失败、可能重置／充值／窗口变化与降采样会断开曲线；没有历史不伪造趋势。当前缓存状态：${q.current_status || '未知'}。`, 'hint'));
  for (const entry of q.current) quota.append(el('p', `现在缓存 · ${entry.label} · ${entry.observation?.status || '未知'} · 观测 ${time(entry.observation?.checked_at)}${entry.last_success && !['available', 'partial'].includes(entry.observation?.status) ? ' · 存在上次成功旧值，非当前确认值' : ''}`, 'hint'));
  if (!q.series.length) quota.append(el('p', '所选范围没有额度历史；不代表没有消耗。'));
  for (const series of q.series) {
    const section = el('section', undefined, 'diagnostic-quota-series'); section.dataset.quotaSeries = series.id;
    section.append(el('h3', `${source(series.connection_id, names)} · ${series.label || series.kind || '额度'} · ${series.unit || '单位未知'}`),
      el('p', `项目 ${series.project_id || '当前项目'} · ${series.provider} · 账号段 ${series.account_key || '未知'} / ${series.source_key || '未知'} · ${series.scope} · 窗口 ${series.window_seconds ? `${series.window_seconds}s` : '未知'} · 适用模型 ${(series.models || []).join('、') || '共享／未限定'}`, 'hint'),
      el('p', `${series.sample_count_lower_bound ? '至少 ' : ''}${series.sample_count} 个观测${series.sampled ? ' · 已降采样，未读部分不可推断' : ''} · ${series.points.filter(point => point.reset).length} 处可能重置／充值 · ${series.points.filter(point => !['available', 'partial'].includes(point.status)).length} 处失败／未知，均断开`),
      chart(series.points, [{ key: 'remaining', label: `剩余 ${series.unit || '未知单位'}`, quota: true }], '额度剩余量（非消费曲线）'));
    const changes = el('div', undefined, 'diagnostic-quota-changes');
    for (const point of series.points) changes.append(el('p', `${time(point.at)} · ${point.status} · 剩余 ${amount(point.remaining)} · 变化 ${amount(point.remaining_change)} ${series.unit || ''}${point.reset ? ' · 可能重置／充值，断开' : ''}${point.error_code ? ' · 观测失败，断开' : ''}`, 'hint'));
    const details = el('details'); details.append(el('summary', '逐次观测与变化'), changes); section.append(details); quota.append(section);
  }
  const current = block('现在的额度缓存（不是选区结束余额）');
  current.append(el('p', '只读设备缓存，不会自动联网刷新；成功值也只代表观测时刻。历史曲线与现在缓存分别阅读。', 'hint'));
  if (!q.current.length) current.append(el('p', '无当前缓存；历史来源可能已删除，未知不等于零。'));
  for (const entry of q.current) {
    const card = el('article'); card.append(el('h3', `${entry.label} · ${entry.project_id || '当前项目'}`), renderConnectionResources(entry.observation));
    if (entry.last_success && !['available', 'partial'].includes(entry.observation?.status)) card.append(el('p', '上次成功旧值（非当前确认值）', 'agent-status-warning'), renderConnectionResources(entry.last_success.observation));
    current.append(card);
  }
  const detail = block('响应与流量明细');
  for (const bucket of data.buckets) { const row = el('article', undefined, 'diagnostic-detail-row'); row.append(el('strong', time(bucket.at)), el('p', `${bucket.requests} 响应 · 输入 ${amount(bucket.input_tokens)} / 输出 ${amount(bucket.output_tokens)} token · 估算 ${amount(bucket.estimated_cost_usd)} USD · ${lower ? '已知下界' : '已知小计'}`)); detail.append(row); }
  const method = block('计算口径');
  method.append(el('p', '连续文本片段速度 = 可证明间隔内 Unicode 码点数之和 ÷ 间隔秒数之和；每段首 chunk 不计入分子，思考／工具事件会断开。单 chunk 或不可测时为未知，不能当 0。'),
    el('p', `总体响应速度 ${amount(s.response_tokens_per_second)} token/s（${s.response_samples} 样本）；首任意有效 delta 等待 ${amount(s.wait_mean_ms)} ms（${s.wait_samples} 样本）；首文本等待 ${amount(s.ttft_mean_ms)} ms（${s.ttft_samples} 样本）。`),
    el('p', '响应以结束时间入桶，输入包含缓存读写，输出不重复叠加思考 token。估算 USD 来自 Pi，不是账单或套餐折算。覆盖比例只针对已采集响应，不能据此推测未结束或未知调用。'));
  root.replaceChildren(coverage, metrics, flow, speed, quota, current, detail, method);
  const entries = [flow, speed, quota, current, detail, method].map((section, index) => ({ section, key: String(index), mode: 'fold' }));
  const views = pageModules(root, { scope: 'runtime-diagnostics', entries });
  // Default overview stays visible; details use the same shared explicit folding foundation.
  views.forEach((view, index) => { if (index >= 3 && !view.states.has(view.key)) view.setExpanded(false, true, false); });
}
