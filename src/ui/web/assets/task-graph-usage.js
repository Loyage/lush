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
  const value = node.resources?.[aggregate ? 'subtree' : 'own'];
  const box = el('span', undefined, 'task-graph-usage');
  if (aggregate) box.classList.add('is-aggregate');
  if (value?.running) box.classList.add('is-live');
  const runtime = value && Number.isFinite(value.run_ms) ? compactRuntime(value.run_ms) : '—';
  const unknownTokens = !value || value.incomplete || value.unknown_tokens > 0;
  const unknownCost = !value || value.incomplete || value.unknown_cost > 0;
  const input = unknownTokens ? '—' : tokens(value.input);
  const output = unknownTokens ? '—' : tokens(value.output);
  const cost = unknownCost ? '—' : `$${value.cost.toFixed(2)}`;
  box.append(el('span', runtime, 'task-graph-usage-runtime'),
    el('span', `↑${input}`, 'task-graph-usage-input'),
    el('span', `↓${output}`, 'task-graph-usage-output'),
    el('span', cost, 'task-graph-usage-cost'));
  box.setAttribute('tabindex', '0');
  box.setAttribute('data-help', `${aggregate ? '此 Worker 与全部后代的累计消耗（含隐藏、归档及图外节点）' : '此 Worker 自身的累计消耗，不含子 Worker'}。运行时间为各轮 Agent 调用的累计时长，不含等待；↑ 输入 token（含缓存读取与写入），↓ 输出 token；美元费用为会话报告的估算，不代表实际账单。— 表示记录缺失或无法完整统计。${value?.running ? '有 Worker 正在运行，数值可能变化。' : ''}`);
  box.setAttribute('aria-label', `${aggregate ? '子树合计' : '自身消耗'}：运行 ${runtime}，输入 ${input}，输出 ${output}，费用 ${cost}`);
  return box;
}
