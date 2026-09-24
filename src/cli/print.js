import { TERMINAL } from '../core/types.js';

/** 一步的终端文本：与 `task transcript` 的既有格式一致，多行正文原样换行。 */
export const transcriptStepText = step => `[${step.seq}] ${step.kind}\t${step.title}${step.at ? `\t${step.at}` : ''}\n${step.body}\n`;
export function printTranscript(page) {
  if (!page.steps.length) { console.log(page.files.length ? '(会话记录里没有可显示的步骤)' : '(这个任务还没有 pi 会话记录)'); return; }
  for (const step of page.steps) console.log(transcriptStepText(step));
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
/** 一键合并的只读计划：逐条分支给出动作与阻塞，供确认前预览。 */
export function printMergeAllPlan(plan) {
  const items = plan?.items ?? [];
  if (!items.length) { console.log(`（${plan?.target_branch ?? '目标分支'} 没有可收拢的后代分支）`); return; }
  console.log(`目标分支 ${plan.target_branch} · 可执行 ${plan.order?.length ?? 0} / 共 ${items.length}${plan.active_run ? ' · 已有运行在进行' : ''}`);
  const ORDER = { merge: '快进合入', sync: '子侧解法', skip: '不处理' };
  for (const item of items) {
    const mark = item.ready ? '→' : '·';
    const detail = [`${ORDER[item.action] || item.action}`,
      item.blockers?.length ? `阻塞：${item.blockers.join('、')}` : ''].filter(Boolean).join(' · ');
    console.log(`${mark} ${item.branch}\t${item.depth}层\t${detail}`);
  }
  if (!plan.order?.length) console.log('没有此刻可执行的合并。');
}
/** 一键合并启动结果：给一句人话，进度看分支图。 */
export function printMergeAllResult(result) {
  if (result.status === 'empty') { console.log(`目标分支 ${result.target_branch}：没有待合并的后代分支。`); return; }
  console.log(`已在 ${result.target_branch} 开始一键合并，按序处理 ${result.plan.order.length} 条分支；进度看 lush branch tree。`);
}
/** 取消结果：明确已完成的不会回滚。 */
export function printMergeCancel(result) {
  console.log(`已取消 ${result.target_branch} 的一键合并；已完成的 ${result.done?.length ?? 0} 条保留，不回滚。`);
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
/* ---------- 分支谱系：记录下来的创建关系，与 commit graph / 任务树都是不同维度 ---------- */
const shortSha = commit => (commit ? String(commit).slice(0, 12) : null);
function branchMarks(node) {
  const marks = [];
  if (node.tracked === false && node.present === true) marks.push('[?]');   // 有 Git ref，但没有 Lush 记录
  if (node.present === false) marks.push('[deleted]');                      // Git ref 已不在（记录或父指针仍在）
  if (node.current) marks.push('*');
  return marks.length ? ` ${marks.join(' ')}` : '';
}
/** 每个节点在 --verbose 下单列出的细节：task / worktree / fork / parent。 */
function branchDetails(node) {
  const out = [];
  if (node.task_id !== null) out.push(`task: ${node.task_role ? `${node.task_role}#${node.task_id}` : `#${node.task_id}`}${node.task_name ? ` ${node.task_name}` : ''}${node.task_goal ? ` · ${oneLine(node.task_goal, 60)}` : ''}`);
  if (node.worktree) out.push(`worktree: ${node.worktree}${node.worktree_exists === false ? '（已不在磁盘上）' : ''}`);
  if (node.created_from_commit) out.push(`fork: ${shortSha(node.created_from_commit)}`);
  out.push(node.parent ? `parent: ${node.parent}（${node.parent_relation ?? 'recorded'}）` : 'parent: unknown');
  if (node.tracked === false && node.present === true) out.push('记录: 无（lush branch import 只登记存在，不推断 parent）');
  if (node.tracked === false && node.present === false) out.push('记录: 无 · Git ref 也不在（只被某个子分支的 parent 指针提到）');
  if (node.created_at) out.push(`created: ${node.created_at}`);
  return out;
}
export function printBranchTree(tree, { verbose = false } = {}) {
  const nodes = [];
  const collect = node => { nodes.push(node); for (const child of node.children) collect(child); };
  (tree.roots || []).forEach(collect);
  if (tree.error) console.error(`lush: ${tree.error}`);
  if (!nodes.length) { console.log('（还没有任何分支记录；创建任务时会自动记录，或先跑 lush branch import）'); return; }
  const tracked = nodes.filter(node => node.tracked).length;
  const untracked = nodes.filter(node => node.tracked === false && node.present === true).length;
  const gone = nodes.filter(node => node.present === false).length;
  console.log(`分支谱系 · 当前 ${tree.current_branch ?? '（detached HEAD）'} · ${nodes.length} 个节点${tree.truncated ? '（已截断）' : ''}`);
  console.log(`已记录 ${tracked} · 未记录 [?] ${untracked} · ref 已不在 [deleted] ${gone} · * = 当前分支`);
  const walk = (node, prefix, isLast) => {
    console.log(`${prefix}${isLast ? '└── ' : '├── '}${node.branch}${branchMarks(node)}`);
    const inner = prefix + (isLast ? '    ' : '│   ');
    if (verbose) for (const detail of branchDetails(node)) console.log(`${inner}${detail}`);
    node.children.forEach((child, index) => walk(child, inner, index === node.children.length - 1));
  };
  tree.roots.forEach((root, index) => walk(root, '', index === tree.roots.length - 1));
  if (tree.truncated) console.error('… 分支太多，只画出前面一部分；用 --json 拿完整数据');
}
function printChain(names) {
  names.forEach((name, index) => console.log(`${'    '.repeat(index)}${index === 0 ? '' : '└── '}${name}`));
}
export function printBranchShow(node) {
  console.log(`branch: ${node.branch}${branchMarks(node)}`);
  console.log(`parent: ${node.parent ? `${node.parent}（${node.parent_relation ?? 'recorded'}）` : 'unknown'}`);
  console.log(`fork commit: ${shortSha(node.created_from_commit) ?? '—'}${node.head_commit && node.head_commit !== node.created_from_commit ? ` · 现在 ${shortSha(node.head_commit)}` : ''}`);
  console.log(`task: ${node.task_id === null ? '—' : `${node.task_role ? `${node.task_role}#${node.task_id}` : `#${node.task_id}（任务已被清理）`}${node.task_name ? ` ${node.task_name}` : ''}`}`);
  console.log(`worktree: ${node.worktree ?? '—'}${node.worktree_exists === false ? '（已不在磁盘上）' : ''}`);
  console.log(`status: ${node.tracked ? node.status ?? 'active' : node.present === false ? '只作为 parent 出现' : 'untracked'} · ${node.present === null ? 'git 不可用' : node.present ? 'ref 存在' : 'ref 已不在'}`);
  console.log(`created: ${node.created_at ?? '—'}`);
  console.log('\nancestors:');
  printChain(node.chain);
  if (node.children.length) { console.log('\nchildren:'); for (const [index, child] of node.children.entries()) console.log(`${index === node.children.length - 1 ? '└── ' : '├── '}${child}`); }
  if (node.descendants.length > node.children.length) console.log(`\ndescendants: ${node.descendants.length}`);
}
/** 摘要结果：分支名 + 刚落下的那句话。 */
export function printBranchSummary(branch) {
  console.log(`${branch.branch}\t${branch.summary}`);
}
export function printBranchImport(result) {
  if (!result.imported) { console.log(`没有需要登记的分支：${result.local} 条本地分支都已有记录。`); return; }
  console.log(`登记 ${result.imported} 条分支记录（只记存在与 worktree，不推断 parent）：`);
  for (const branch of result.branches) console.log(`  ${branch}`);
  console.log(`本地分支 ${result.local} 条，原有记录 ${result.recorded} 条。`);
}
/** 归档结果：一条分支一行（归档的是整棵子树，所以可能不止一行），后面是保留下来的东西。 */
export function printBranchArchive(result) {
  const branches = Array.isArray(result.branches) && result.branches.length ? result.branches : [result];
  console.log(`已归档 ${result.branch}${branches.length > 1 ? `（连同 ${branches.length - 1} 条后代分支，共 ${branches.length} 条）` : ''}`);
  for (const entry of branches) {
    const worktree = entry.worktree === 'removed' ? '已删除' : '本来就不在';
    const ref = entry.ref === 'deleted' ? '已删除' : '本来就不在';
    const name = entry.branch === result.branch ? '' : `  ${entry.branch}  `;
    console.log(`${name}worktree\t${worktree}${entry.discarded ? '（丢弃了未提交改动）' : ''} · 本地分支\t${ref}${entry.tip ? `（tip ${shortSha(entry.tip)}）` : ''}`);
  }
  console.log(`保留任务\t${result.tasks.length} 个${result.tasks.length ? `：${result.tasks.map(task => `#${task.id} ${task.status}`).join('、')}` : ''}`);
  if (result.showcases?.length) console.log(`效果展示\t保留 ${result.showcases.length} 条记录，删除 ${result.showcase_worktrees ?? 0} 个 detached worktree`);
  console.log(`会话文件\t${result.sessions.length} 个`);
  for (const file of result.sessions) console.log(`  ${file}`);
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
