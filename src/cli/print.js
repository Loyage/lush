import { TERMINAL } from '../core/types.js';

export function printTranscript(page) {
  if (!page.steps.length) { console.log(page.files.length ? '(会话记录里没有可显示的步骤)' : '(这个任务还没有 pi 会话记录)'); return; }
  for (const step of page.steps) console.log(`[${step.seq}] ${step.kind}\t${step.title}${step.at ? `\t${step.at}` : ''}\n${step.body}\n`);
  if (page.has_more) console.error(`… 还有更多步骤；用 --after ${page.next} 继续`);
  if (page.truncated) console.error('… 会话记录过大，只读取了前面一部分');
}
export function printUsage(usage) {
  if (!usage.files.length) { console.log('(这个任务还没有 pi 会话记录)'); return; }
  const model = usage.model ? [usage.model.provider, usage.model.model_id].filter(Boolean).join('/') : '—';
  const t = usage.totals;
  console.log(`模型\t${model}${usage.thinking_level ? ` · 思考等级 ${usage.thinking_level}` : ''}`);
  console.log(`上下文\t${usage.context_tokens} tokens（最近一次请求）`);
  console.log(`累计\t输入 ${t.input} · 输出 ${t.output} · 缓存读 ${t.cache_read} · 缓存写 ${t.cache_write} · 推理 ${t.reasoning}`);
  console.log(`花费\t$${t.cost.toFixed(6)}（${usage.requests} 次模型请求）`);
  console.log(`会话\t${usage.files.length} 个文件${usage.compacted ? ` · 上下文压缩 ${usage.compacted} 次` : ''}`);
  if (usage.last) console.log(`最近一次执行\t${usage.last.at ?? '—'}${usage.last.title ? ` · ${usage.last.title}` : ''}\t${oneLine(usage.last.body, 80)}`);
  if (usage.truncated) console.error('… 会话记录过大，统计只覆盖前面一部分');
}
/** 批量合并的人类可读汇总：每行一个任务，最后一行给总量与停止点。 */
const MERGE_STATUS_WORD = { merged: '已合并', conflict: '冲突待处理', failed: '失败', skipped: '已跳过' };
export function printMergeMany(result) {
  if (!result.merges.length) { console.log('(没有任务需要合并)'); return; }
  for (const row of result.merges) {
    const word = MERGE_STATUS_WORD[row.status] || row.status;
    const extra = [row.source_task_id ? `实际来源 #${row.source_task_id}` : '', row.integration ? `integration=${row.integration}` : '',
      row.resolution_task_id ? `解冲突任务 #${row.resolution_task_id}` : '', row.included ? '随前一项一并落地' : '', row.error || ''].filter(Boolean).join(' · ');
    console.log(`#${row.id}\t${word}${extra ? `\t${extra}` : ''}`);
  }
  console.log(`共 ${result.merges.length} 个：已合并 ${result.merged}${result.stopped ? `；在 #${result.stopped.id} 停止（${result.stopped.reason}）` : ''}`);
}
/* ---------- 并行/串行关系：任务树、交付队列、时间轴 ---------- */
const DEP_MARK = { code: '⛓', order: '⏳' };
const DEP_WORD = { code: '基线', order: '顺序' };
const WAIT_LABEL = { dep: '等依赖', children: '等子任务', user: '等你决定', slot: '等并发槽', setup: '没跑起来就结束' };
const INTEGRATION_WORD = { pending: '待合并', review: '待复查', merging: '合并中', merged: '已合并', conflict: '冲突待处理', superseded: '已作废' };
const oneLine = (value, max = 60) => String(value ?? '').replace(/\s+/g, ' ').slice(0, max);
const indent = depth => '  '.repeat(depth);
const settled = dep => TERMINAL.has(dep.status);
function depLabels(task) {
  return (task.deps || []).map(dep => `${DEP_MARK[dep.kind] || ''}#${dep.id}${DEP_WORD[dep.kind] || ''}${settled(dep) ? '' : '·等'}`).join(' ');
}
/** 此刻为什么没在干活；和 Web 树里那行是同一套说法。 */
function whyText(task, children = []) {
  const waiting = (task.deps || []).filter(dep => !settled(dep));
  if (task.status === 'running') return '在跑（占 1 个并发槽）';
  if (task.status === 'queued') return waiting.length ? `排队：等 ${waiting.map(dep => `#${dep.id}`).join('、')}` : '排队：等并发槽';
  if (task.status === 'waiting') return `等子任务（${children.filter(child => child.status === 'running').length} 个在跑）`;
  if (task.status === 'awaiting') return '等你决定';
  if (task.status === 'completed' && task.integration === 'conflict') return '合并冲突：等你决定要不要开解冲突任务';
  if (task.status === 'completed' && ['pending', 'review'].includes(task.integration)) return '等你批准合并';
  return null;
}
/** 兄弟之间无依赖＝可以同时跑；有依赖＝串成链。 */
function siblingChain(children) {
  const ids = new Set(children.map(child => child.id));
  const inner = new Map(children.map(child => [child.id, (child.deps || []).filter(dep => ids.has(dep.id))]));
  const level = new Map();
  const depth = (taskId, seen = new Set()) => {
    if (level.has(taskId)) return level.get(taskId);
    if (seen.has(taskId)) return 0;
    seen.add(taskId);
    const upstreams = inner.get(taskId) || [];
    const value = upstreams.length ? 1 + Math.max(...upstreams.map(dep => depth(dep.id, seen))) : 0;
    level.set(taskId, value); return value;
  };
  for (const child of children) depth(child.id);
  const levels = new Map();
  for (const child of children) { const at = level.get(child.id); if (!levels.has(at)) levels.set(at, []); levels.get(at).push(child.id); }
  return [...levels.entries()].sort((a, b) => a[0] - b[0]).map(([, group]) => group.sort((a, b) => a - b));
}
export function printTree(value, status) {
  const roots = Array.isArray(value) ? value : [value];
  const flat = [];
  const collect = node => { flat.push(node); for (const child of node.children || []) collect(child); };
  roots.forEach(collect);
  const ready = flat.filter(task => task.status === 'queued' && !(task.deps || []).some(dep => !settled(dep))).length;
  console.log(`并发上限 ${status?.concurrency ?? '?'} · ${status?.agents?.length ?? '?'} 个在跑 · ${ready} 个在等槽 · ${flat.length} 个任务`);
  console.log('⛓ = 分支基线（必须先合上游）  ⏳ = 只等上游结束  ‖ = 兄弟之间无依赖，可同时跑');
  const walk = (node, depth) => {
    const children = node.children || [];
    if (children.length > 1) {
      const chain = siblingChain(children).map(group => group.length > 1 ? `{${group.map(taskId => `#${taskId}`).join(' ‖ ')}}` : `#${group[0]}`).join(' → ');
      console.log(`${indent(depth + 1)}‖ ${chain}（并列的可同时跑）`);
    }
    const meta = [depLabels(node), INTEGRATION_WORD[node.integration] || '', whyText(node, children)].filter(Boolean).join(' · ');
    console.log(`${indent(depth)}#${node.id} ${node.role} ${node.status}${meta ? `  ${meta}` : ''}  ${oneLine(node.goal)}`);
    for (const child of children) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
}
export function printLadder(ladder) {
  if (!ladder.nodes.length) { console.log('没有待交付的变更。'); return; }
  if (ladder.groups?.length) {
    console.log(`交付队列${ladder.current_branch ? ` · 当前分支 ${ladder.current_branch}` : ''}${ladder.truncated ? '（只列出前 50 个）' : ''}`);
    for (const group of ladder.groups) {
      console.log(`\n→ ${group.target_branch}${group.current ? '（当前检出）' : ''} · ${group.ready} 个就绪`);
      for (const item of group.items) {
        const source = item.source_task_id !== item.id ? ` · 落地来源 #${item.source_task_id}` : '';
        console.log(`${indent(item.level)}#${item.id} ${item.phase}${source}  ${oneLine(item.goal)}`);
        for (const dep of item.deps) console.log(`${indent(item.level + 1)}${dep.kind === 'code' ? '⛓ 代码基线' : '⏳ 仅执行依赖'} #${dep.id}${dep.merged ? '（已落地）' : ''}`);
        for (const blocker of item.blockers) console.log(`${indent(item.level + 1)}⛔ ${blocker.message}`);
      }
    }
    return;
  }
  console.log(`交付队列 → ${ladder.target_branch}${ladder.truncated ? '（只列出前 50 个）' : ''}`);
  for (const node of ladder.nodes) {
    console.log(`${indent(node.level)}L${node.level} #${node.id} ${node.role} ${node.branch}`);
    for (const dep of node.deps) console.log(`${indent(node.level + 1)}${dep.kind === 'code' ? '⛓ 必须先合' : '⏳ 仅执行依赖'} #${dep.id} ${dep.branch ?? ''}${dep.merged ? '（已合并）' : ''}`);
  }
}
export function printTimeline(page) {
  const start = Date.parse(page.start), end = Date.parse(page.end), span = Math.max(end - start, 1);
  const width = Math.max(24, Math.min((process.stdout.columns || 100) - 34, 96));
  const cell = at => Math.max(0, Math.min(width, Math.round(((at - start) / span) * width)));
  const stamp = at => new Date(at).toTimeString().slice(0, 8);
  console.log(`${stamp(start)} → ${stamp(end)} · 并发上限 ${page.concurrency}${page.clamped ? ' · 窗口已截断' : ''}${page.truncated ? ' · 更早的任务未列出' : ''}`);
  for (const task of page.tasks) {
    const track = Array(width).fill('·');
    // 只看得到方格的变化：毫秒级的调度延迟不画，也不进"在等什么"的说明。
    const visible = task.segments.filter(segment => segment.kind === 'run' || segment.reason === 'setup' || cell(Date.parse(segment.end)) > cell(Date.parse(segment.start)));
    for (const segment of visible) {
      const from = cell(Date.parse(segment.start)), to = Math.max(from + 1, cell(Date.parse(segment.end)));
      for (let index = from; index < to && index < width; index += 1) track[index] = segment.kind === 'run' ? '█' : '▒';
    }
    const waits = [...new Set(visible.filter(segment => segment.kind === 'wait' && segment.reason).map(segment => WAIT_LABEL[segment.reason] || segment.reason))];
    console.log(`#${String(task.id).padEnd(3)} ${task.role.padEnd(11)} ${track.join('')} ${waits.join('/')}${task.segments.some(segment => segment.open) ? ' ←进行中' : ''}`);
  }
  console.log('█ = 真的在跑（invocation 区间）  ▒ = 排队  · = 任务已结束');
}
