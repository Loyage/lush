import { $, block, button, el } from './dom.js';
import { action } from './api.js';
import { INTEGRATION, MERGE_STATUS } from './format.js';
import { isMergeable, ladderEdges, mergeCandidates, previewMergeOrder } from './merge-select.js';
import { detail, refresh } from './navigate.js';
import { mergeSelection, ui } from './state.js';

/* ---------- 批量合并的选择 ---------- */
/** 合并一批选中的任务：先按与运行时相同的规则预览顺序，再整批交给 task.merge_many。 */
export async function mergeBatch(ids, candidates) {
  const picked = [...new Set(ids)];
  if (!picked.length) return;
  const nodes = ui.lastSnapshot?.ladder?.nodes || [];
  const order = previewMergeOrder(picked, ladderEdges(nodes));
  const goalOf = id => candidates.find(candidate => candidate.id === id)?.goal || nodes.find(node => node.id === id)?.goal || '';
  const lines = order.map((taskId, index) => `${index + 1}. #${taskId}${goalOf(taskId) ? ` ${String(goalOf(taskId)).slice(0, 40)}` : ''}`);
  if (!confirm(`将按依赖顺序合并 ${order.length} 个任务（上游先合，逐个写主树，遇到冲突或错误就停下并把剩余跳过）：\n\n${lines.join('\n')}\n\n请先确认代码与测试结果都审阅过。`)) return;
  const result = await action('task.merge_many', { ids: picked });
  ui.lastMergeResult = { requested: order, result };
  ui.overviewKey = null;   // 结果要落在概览里，强制重画一次
  await refresh();
}

/** 合并阶梯：该先合哪个、哪些已经被别的分支带进来了，以及勾选 / 一键多任务合并。 */
export function renderLadder(data) {
  const nodes = data?.ladder?.nodes || [];
  const candidates = mergeCandidates(data?.tasks || [], { nodes, freeze: data?.status?.merge_freeze || [] });
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  // 已经不合法的勾选（任务合完了 / 被冻结 / 从阶梯消失）在重画时清掉。
  for (const id of [...mergeSelection]) if (!byId.has(id) || !isMergeable(byId.get(id))) mergeSelection.delete(id);
  const mergeable = candidates.filter(isMergeable);

  // 这里就是「待你批准合并」：待合并分支、谁必须先合、谁已经被别人带进来了。
  const section = block('合并阶梯', nodes.length ? `待批准 ${nodes.length}` : undefined);
  if (!nodes.length) { section.append(el('p', '没有待合并的分支。', 'hint')); return section; }
  section.append(el('p', '⛓ code 依赖＝下游 worktree 的基线：必须先合上游，否则下游的分支会把它一起带进来。\n⏳ order 依赖只要求上游结束，所以下游可以先合——那时它有没有把上游带进来由 git 判定。', 'hint'));

  const boxes = new Map();
  const actions = el('div', undefined, 'actions pick-actions');
  const mergeSelected = button('合并选中', () => mergeBatch(mergeable.filter(candidate => mergeSelection.has(candidate.id)).map(candidate => candidate.id), candidates));
  const mergeAll = button('一键合并所有可合并任务', () => mergeBatch(mergeable.map(candidate => candidate.id), candidates));
  const selectAll = button('全选可合并', () => { for (const candidate of mergeable) mergeSelection.add(candidate.id); sync(); }, 'ghost');
  const clearAll = button('清空选择', () => { mergeSelection.clear(); sync(); }, 'ghost');
  const sync = () => {
    const picked = mergeable.filter(candidate => mergeSelection.has(candidate.id)).length;
    mergeSelected.textContent = `合并选中 (${picked})`;
    mergeSelected.disabled = !picked;
    mergeAll.textContent = `一键合并所有可合并任务 (${mergeable.length})`;
    mergeAll.disabled = !mergeable.length;
    selectAll.disabled = !mergeable.length;
    clearAll.disabled = !mergeSelection.size;
    for (const [id, box] of boxes) box.checked = mergeSelection.has(id);
  };
  actions.append(mergeSelected, mergeAll, selectAll, clearAll);
  section.append(actions);

  for (const node of nodes) {
    const candidate = byId.get(node.id);
    const line = el('div', undefined, `ladder l${Math.min(node.level, 5)}`);
    const row = el('div', undefined, 'row');
    if (candidate) {
      const box = el('input', undefined, 'pick');
      box.type = 'checkbox'; box.checked = mergeSelection.has(candidate.id); box.disabled = !isMergeable(candidate);
      box.setAttribute('aria-label', `选择任务 #${candidate.id} 参与批量合并`);
      box.title = isMergeable(candidate) ? '勾选后点「合并选中」' : `合并被冻结：#${candidate.frozen_by} 的冲突还没解决`;
      box.onchange = () => {
        if (box.checked) mergeSelection.add(candidate.id); else mergeSelection.delete(candidate.id);
        sync();
      };
      boxes.set(candidate.id, box);
      row.append(box);
    } else {
      // 还没到 completed（比如刚创建的解冲突任务）：列出来说明它占着阶梯，但不可合并。
      row.append(el('span', '·', 'tid'));
    }
    row.append(el('span', `L${node.level}`, 'tid'), el('span', `#${node.id}`, 'tid'),
      button(node.goal, () => detail(node.id), 'link'),
      el('span', [INTEGRATION[node.integration] || node.integration, node.branch].filter(Boolean).join(' · '), 'when'));
    line.append(row);
    for (const dep of node.deps) {
      line.append(el('span', `${dep.kind === 'code' ? '⛓ 必须先合' : '⏳ 只等结束'} #${dep.id}${dep.merged ? '（已合并）' : ''}${dep.kind === 'order' && dep.contains ? '（它的提交已经在你里面）' : ''}`, 'meta'));
    }
    if (node.covered_by.length) line.append(el('span', `⚠ 已经被 #${node.covered_by.join('、')} 带进来：合后者即可，本分支会变成 no-op`, 'meta warn'));
    if (candidate && candidate.frozen_by) line.append(el('span', `⛔ 合并被冻结：#${candidate.frozen_by} 的冲突还没解决，先处理它的待决问题`, 'meta warn'));
    section.append(line);
  }
  sync();
  const first = nodes.filter(node => node.level === 0 && !node.covered_by.length).map(node => node.id);
  if (first.length) section.append(el('p', `建议先合 ${first.map(taskId => `#${taskId}`).join('、')}；命令：lush task merge <id> ，或在上面勾选后一键合并。`));
  if (ui.lastMergeResult) section.append(renderMergeResult(ui.lastMergeResult));
  return section;
}

/** 批量合并的逐条结果：成功、失败原因、冲突并指向新开的解冲突任务。 */
export function renderMergeResult(entry) {
  const { result } = entry;
  const section = block('批量合并结果', `${result.merged} 个成功`);
  const summary = result.stopped
    ? `合并 ${result.merged} 个后停在 #${result.stopped.id}：${result.stopped.reason}；剩余任务已跳过（未动主树）。`
    : `全部合并成功：${result.merged} 个。`;
  section.append(el('p', summary, result.stopped ? 'hint warn' : 'hint'));
  for (const row of result.merges) {
    const line = el('div', undefined, 'row');
    line.append(el('span', MERGE_STATUS[row.status] || row.status, `c-${row.status === 'merged' ? 'completed' : row.status === 'conflict' || row.status === 'failed' ? 'failed' : 'queued'}`),
      el('span', `#${row.id}`, 'tid'));
    if (row.status === 'conflict' && row.resolution_task_id) {
      line.append(el('span', `已开解冲突任务 #${row.resolution_task_id}`, 'meta'), button('查看解冲突任务', () => detail(row.resolution_task_id), 'link'));
    } else if (row.error && row.status !== 'merged') line.append(el('span', row.error, 'meta'));
    if (row.status === 'merged') line.append(el('span', '已进入目标分支', 'meta'));
    section.append(line);
  }
  const actions = el('div', undefined, 'actions');
  actions.append(button('收起结果', () => { ui.lastMergeResult = null; ui.overviewKey = null; return refresh(); }, 'ghost'));
  section.append(actions);
  return section;
}
