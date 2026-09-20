import { $, block, button, el } from './dom.js';
import { action } from './api.js';
import { MERGE_STATUS } from './format.js';
import { isMergeable, ladderEdges, mergeCandidates, previewMergeOrder } from './merge-select.js';
import { detail, refresh } from './navigate.js';
import { mergeSelection, ui } from './state.js';

const PHASE = {
  awaiting_review: '待审阅与批准',
  review_required: '合并曾中断 · 需复查',
  conflict_decision: '等待决定是否解冲突',
  resolving: '正在解冲突',
  resolution_ready: '解冲突结果待落地',
  resolution_stale: '解冲突结果已过期',
};

/* ---------- 批量交付 ---------- */
/** 合并一批稳定的“原任务 id”；后端会把有现成 resolver 的条目映射到真正的来源分支。 */
export async function mergeBatch(ids, candidates) {
  const picked = [...new Set(ids)].map(id => candidates.find(candidate => candidate.id === id)).filter(Boolean);
  if (!picked.length) return;
  const targets = [...new Set(picked.map(candidate => candidate.target_branch))];
  if (targets.length !== 1) throw new Error('一次只能合并到一个目标分支');
  const nodes = ui.lastSnapshot?.ladder?.nodes || [];
  const order = previewMergeOrder(picked.map(candidate => candidate.id), ladderEdges(nodes));
  const byId = new Map(picked.map(candidate => [candidate.id, candidate]));
  const lines = order.map((taskId, index) => {
    const candidate = byId.get(taskId);
    const source = candidate?.merge_id && candidate.merge_id !== taskId ? `（落地解冲突结果 #${candidate.merge_id}）` : '';
    return `${index + 1}. #${taskId}${candidate?.goal ? ` ${String(candidate.goal).slice(0, 40)}` : ''}${source}`;
  });
  if (!confirm(`将向 ${targets[0]} 依次交付 ${order.length} 个变更（只按代码基线排序，遇到冲突或错误就停止；此前已成功的不会回滚）：\n\n${lines.join('\n')}\n\n请先确认代码与测试结果都已审阅。`)) return;
  const result = await action('task.merge_many', { ids: picked.map(candidate => candidate.id) });
  ui.lastMergeResult = { requested: order, result };
  ui.overviewKey = null;
  await refresh();
}

function fallbackGroups(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const target = candidate.target_branch || '(未知目标分支)';
    if (!groups.has(target)) groups.set(target, []);
    groups.get(target).push(candidate);
  }
  return [...groups].map(([target_branch, items]) => ({ target_branch, current: null, items }));
}

/** 交付队列：按目标分支分组；code 链是变更栈，resolver 只作为原任务的当前落地来源。 */
export function renderLadder(data) {
  const ladder = data?.ladder || {};
  const nodes = ladder.nodes || [];
  const candidates = mergeCandidates(data?.tasks || [], { nodes, groups: ladder.groups || [], freeze: data?.status?.merge_freeze || [] });
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  for (const id of [...mergeSelection]) if (!byId.has(id) || !isMergeable(byId.get(id))) mergeSelection.delete(id);

  const section = block('交付队列', candidates.length ? `待处理 ${candidates.length}` : undefined);
  section.classList.add('delivery-panel');
  if (!candidates.length) {
    const empty = el('div', undefined, 'empty-state');
    empty.append(el('span', '✓', 'empty-icon'), el('strong', '没有待交付的变更。'), el('p', 'Agent 完成的代码变更会在这里等待你审阅与批准。', 'hint'));
    section.append(empty);
    if (ui.lastMergeResult) section.append(renderMergeResult(ui.lastMergeResult));
    return section;
  }
  section.append(el('p', '审阅 → 批准 → 进入目标分支。代码基线决定交付顺序，每次只处理一个目标分支。', 'hint'));

  const groups = ladder.groups?.length
    ? ladder.groups.map(group => ({ ...group, items: group.items.map(item => byId.get(item.id)).filter(Boolean) }))
    : fallbackGroups(candidates);
  const boxes = new Map();
  const controls = [];
  const selectStack = candidate => {
    for (const dep of (candidate.deps || []).filter(edge => edge.kind === 'code')) {
      const upstream = byId.get(dep.id);
      if (upstream && isMergeable(upstream)) selectStack(upstream);
    }
    mergeSelection.add(candidate.id);
  };

  const sync = () => {
    for (const [id, box] of boxes) box.checked = mergeSelection.has(id);
    for (const control of controls) {
      const ready = control.items.filter(isMergeable);
      const picked = ready.filter(item => mergeSelection.has(item.id));
      control.selected.textContent = `合并本分支选中 (${picked.length})`;
      control.selected.disabled = !picked.length;
      control.all.textContent = `合并本分支全部可交付 (${ready.length})`;
      control.all.disabled = !ready.length;
    }
  };

  for (const group of groups) {
    const groupItems = group.items || [];
    const groupBlock = block(`目标分支 ${group.target_branch}`, group.current === true ? '当前检出' : group.current === false ? `当前检出 ${ladder.current_branch || '其它分支'}` : undefined);
    groupBlock.classList.add('delivery-group');
    const ready = groupItems.filter(isMergeable);
    const actions = el('div', undefined, 'actions pick-actions');
    const selected = button('', () => mergeBatch(ready.filter(item => mergeSelection.has(item.id)).map(item => item.id), candidates));
    const all = button('', () => mergeBatch(ready.map(item => item.id), candidates), 'ghost');
    const clear = button('清空选择', () => { mergeSelection.clear(); sync(); }, 'ghost');
    controls.push({ items: groupItems, selected, all });
    actions.append(selected, all, clear); groupBlock.append(actions);

    for (const candidate of groupItems) {
      const line = el('div', undefined, `ladder delivery-card ${candidate.ready ? 'is-ready' : 'is-blocked'} l${Math.min(candidate.level || 0, 5)}`);
      const row = el('div', undefined, 'row');
      const box = el('input', undefined, 'pick');
      box.type = 'checkbox'; box.checked = mergeSelection.has(candidate.id); box.disabled = !isMergeable(candidate);
      box.setAttribute('aria-label', `选择任务 #${candidate.id} 参与批量合并`);
      box.title = isMergeable(candidate)
        ? ((candidate.blockers || []).some(item => item.code === 'code_upstream') ? '勾选时会自动带上同一变更栈的 code 上游' : '勾选后合并到本目标分支')
        : (candidate.blockers || []).map(item => item.message).join('\n');
      box.onchange = () => {
        if (box.checked) {
          // 选择另一个目标分支时清掉旧选择，避免界面制造跨分支批次。
          for (const id of [...mergeSelection]) if (byId.get(id)?.target_branch !== candidate.target_branch) mergeSelection.delete(id);
          selectStack(candidate);
        } else mergeSelection.delete(candidate.id);
        sync();
      };
      boxes.set(candidate.id, box);
      row.append(box, el('span', `#${candidate.id}`, 'tid'), button(candidate.goal, () => detail(candidate.id), 'link'),
        el('span', PHASE[candidate.phase] || candidate.phase || candidate.integration, `delivery-phase ${candidate.ready ? 'b-completed' : 'b-awaiting'}`));
      line.append(row);
      if (candidate.merge_id && candidate.merge_id !== candidate.id) {
        line.append(el('span', `↳ 当前落地来源：解冲突任务 #${candidate.merge_id}`, 'meta'));
      }
      for (const dep of candidate.deps || []) {
        line.append(el('span', `${dep.kind === 'code' ? '⛓ 代码基线' : '⏳ 仅执行依赖'} #${dep.id}${dep.merged ? '（已落地）' : ''}`, 'meta'));
      }
      for (const blocker of candidate.blockers || []) line.append(el('span', `! ${blocker.message}`, 'delivery-blocker'));
      if (candidate.covered_by?.length) line.append(el('span', `提示：提交也存在于 #${candidate.covered_by.join('、')}；任一分支落地后系统会按 Git 事实自动收口状态。`, 'meta'));
      groupBlock.append(line);
    }
    section.append(groupBlock);
  }
  sync();
  if (ui.lastMergeResult) section.append(renderMergeResult(ui.lastMergeResult));
  return section;
}

/** 批量合并的逐条结果：成功、失败原因、冲突并指向新开的解冲突任务。 */
export function renderMergeResult(entry) {
  const { result } = entry;
  const section = block('批量交付结果', `${result.merged} 个成功`);
  const summary = result.stopped
    ? `已向 ${result.target_branch || '目标分支'} 交付 ${result.merged} 个，随后停在 #${result.stopped.id}：${result.stopped.reason}；剩余任务未执行。`
    : `全部交付成功：${result.merged} 个${result.target_branch ? ` → ${result.target_branch}` : ''}。`;
  section.append(el('p', summary, result.stopped ? 'hint warn' : 'hint'));
  for (const row of result.merges) {
    const line = el('div', undefined, 'row');
    line.append(el('span', MERGE_STATUS[row.status] || row.status, `c-${row.status === 'merged' ? 'completed' : row.status === 'conflict' || row.status === 'failed' ? 'failed' : 'queued'}`),
      el('span', `#${row.id}`, 'tid'));
    if (row.source_task_id && row.source_task_id !== row.id) line.append(el('span', `通过解冲突任务 #${row.source_task_id}`, 'meta'));
    if (row.status === 'conflict' && row.resolution_task_id) {
      line.append(el('span', `已开解冲突任务 #${row.resolution_task_id}`, 'meta'), button('查看解冲突任务', () => detail(row.resolution_task_id), 'link'));
    } else if (row.error && row.status !== 'merged') line.append(el('span', row.error, 'meta'));
    if (row.status === 'merged') line.append(el('span', row.included ? '已随前一项进入目标分支' : '已进入目标分支', 'meta'));
    section.append(line);
  }
  const actions = el('div', undefined, 'actions');
  actions.append(button('收起结果', () => { ui.lastMergeResult = null; ui.overviewKey = null; return refresh(); }, 'ghost'));
  section.append(actions);
  return section;
}
