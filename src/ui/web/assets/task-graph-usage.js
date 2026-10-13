import { el } from './dom.js';
import { tokens } from './format.js';

/** Show every unit from the largest nonzero unit down to seconds. */
function compactRuntime(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const parts = [
    [Math.floor(seconds / 86400), 'd'],
    [Math.floor(seconds % 86400 / 3600), 'h'],
    [Math.floor(seconds % 3600 / 60), 'm'],
    [seconds % 60, 's'],
  ];
  const first = parts.findIndex(([value]) => value > 0);
  return parts.slice(first < 0 ? -1 : first).map(([value, unit]) => `${value} ${unit}`).join(' ');
}

/** Only backend lifetime summaries are authoritative, never the visible forest. */
export function resourceSummary(node, folded) {
  const aggregate = folded && (node.children_total > 0 || node.children?.length > 0);
  const value = node.details_pending ? undefined : node.resources?.[aggregate ? 'subtree' : 'own'];
  const box = el('span', undefined, 'task-graph-usage');
  if (aggregate) box.classList.add('is-aggregate');
  if (value?.running) box.classList.add('is-live');
  const runtime = value && Number.isFinite(value.run_ms) ? compactRuntime(value.run_ms) : '—';
  const unknownTokens = !value || value.incomplete || value.unknown_tokens > 0;
  const unknownCost = !value || value.incomplete || value.unknown_cost > 0;
  // A positive subtotal is not evidence of coverage. Old daemons intentionally
  // keep the conservative dash when these optional request counts are absent.
  const knownTokens = unknownTokens && Number.isInteger(value?.known_tokens) && value.known_tokens > 0;
  const knownCost = unknownCost && Number.isInteger(value?.known_cost) && value.known_cost > 0;
  const input = unknownTokens && !knownTokens ? '—' : tokens(value.input);
  const output = unknownTokens && !knownTokens ? '—' : tokens(value.output);
  const cost = unknownCost && !knownCost ? '—' : `$${value.cost.toFixed(2)}`;
  box.append(el('span', runtime, 'task-graph-usage-runtime'));
  if (value && (unknownTokens || unknownCost)) box.append(el('span', '统计不完整', 'task-graph-usage-incomplete'));
  box.append(el('span', `${knownTokens ? '已知 ' : ''}↑${input}`, 'task-graph-usage-input'),
    el('span', `${knownTokens ? '已知 ' : ''}↓${output}`, 'task-graph-usage-output'),
    el('span', `${knownCost ? '已知 ' : ''}${cost}`, 'task-graph-usage-cost'));
  box.setAttribute('tabindex', '0');
  const coverageHelp = value && (unknownTokens || unknownCost)
    ? `${value.pending_files > 0 ? '后台补齐中，尚有用量文件未补齐或签名失效。' : '存在记录缺失或无法完整统计的用量，统计不完整。'}token 与费用分别判断；已知值仅是有证据的小计，不是完整总额。`
    : '';
  box.setAttribute('data-help', `${node.details_pending ? '累计消耗正在加载，— 不代表零。' : ''}${aggregate ? '此 Worker 与全部后代的累计消耗（含隐藏、归档及图外节点）' : '此 Worker 自身的累计消耗，不含子 Worker'}。用量由后台补齐，不按当前可见节点相加。运行时间为各轮 Agent 调用的累计时长，不含等待；↑ 输入 token（含缓存读取与写入），↓ 输出 token；美元费用为会话报告的估算，不代表实际账单。${coverageHelp}— 表示没有有效的已知用量证据，不代表零。${value?.running ? '有 Worker 正在运行，数值可能变化。' : ''}`);
  box.setAttribute('aria-label', `${aggregate ? '子树合计' : '自身消耗'}${value && (unknownTokens || unknownCost) ? '，统计不完整' : ''}：运行 ${runtime}，输入 ${knownTokens ? '已知小计 ' : ''}${input}，输出 ${knownTokens ? '已知小计 ' : ''}${output}，费用 ${knownCost ? '已知小计 ' : ''}${cost}${node.details_pending ? '，累计消耗正在加载' : ''}`);
  return box;
}
