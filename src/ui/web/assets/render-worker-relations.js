import { badge, block, button, el, statusBadge } from './dom.js';
import { api, isReadAbort } from './api.js';
import { detail } from './navigate.js';
import { INTEGRATION, taskTitle } from './format.js';
import { workerLabel } from './worker-label.js';
import { referenceable } from './context-references.js';

const PAGE_SIZE = 50;

/** Refresh exactly the previously opened range, not the entire project/descendant tree. */
export async function loadWorkerRelations(taskId, { count = 0, signal } = {}) {
  let result = null, after = 0;
  do {
    const page = await api(`/api/worker/${taskId}/relations?after=${after}&limit=${PAGE_SIZE}`, { signal });
    if (!result) result = page;
    else result = { ...page, children: { ...page.children, items: [...result.children.items, ...page.children.items] } };
    if (!result.children.has_more || result.children.items.length >= count) break;
    const cursor = result.children.cursor;
    if (!(cursor > after)) throw new Error('Worker 关系分页游标未推进。');
    after = cursor;
  } while (true);
  return result;
}

function workerRow(worker, relation, current = false) {
  const row = el('div', undefined, 'worker-relation-row');
  row.dataset.workerId = String(worker.id);
  row.append(el('span', relation, 'worker-relation-label'), el('span', workerLabel(worker), 'tid'));
  if (current) {
    row.classList.add('is-current'); row.setAttribute('aria-current', 'true');
    row.append(el('span', taskTitle(worker), 'worker-relation-title'));
  } else row.append(button(taskTitle(worker), () => detail(worker.id), 'link worker-relation-title', { worker }));
  row.append(statusBadge(worker));
  if (INTEGRATION[worker.integration]) row.append(badge(INTEGRATION[worker.integration], worker.integration === 'merged' ? 'b-completed' : 'b-awaiting'));
  referenceable(row, [
    { kind: 'task', target: { task_id: worker.id }, label: `Worker ${workerLabel(worker)}`, quote: worker.goal,
      location: { view: 'task-detail', task_id: worker.id } },
    { kind: 'task_subtree', target: { task_id: worker.id }, label: `Worker 子树 ${workerLabel(worker)}`, quote: worker.goal,
      location: { view: 'task-detail', task_id: worker.id } },
  ]);
  return row;
}

/** One parent, the selected Worker, and only direct children. No status/archive filtering. */
export function renderWorkerRelations(task, { data = null, current = () => true, signal } = {}) {
  const section = block('Worker 关系'); section.classList.add('worker-relations');
  const body = el('div', undefined, 'worker-relations-body'); section.append(body);
  let state = data, generation = 0, loading = false, error = '', available = data ? true : null;
  let active = current, readSignal = signal;
  const alive = epoch => epoch === generation && active() && !readSignal?.aborted;
  const paint = () => {
    body.replaceChildren();
    const tree = el('ul', undefined, 'worker-relation-tree');
    tree.setAttribute('aria-label', '直接父 Worker、当前 Worker 与直接子 Worker');
    const selected = el('li'); selected.append(workerRow(task, '当前 Worker', true));
    let parent = state?.parent;
    if (task.parent_id) {
      const item = el('li');
      if (parent?.id === task.parent_id) item.append(workerRow(parent, '直接父 Worker'));
      else {
        const row = el('div', undefined, 'worker-relation-row');
        row.append(el('span', '直接父 Worker', 'worker-relation-label'),
          button(workerLabel(task.parent_id, task.parent_worker_number), () => detail(task.parent_id), 'link', { worker: task.parent_id }),
          el('span', available === false ? '状态不可用' : '状态加载中…', 'hint'));
        item.append(row);
      }
      const branch = el('ul'); branch.append(selected); item.append(branch); tree.append(item);
    } else {
      body.append(el('p', '没有直接父 Worker。', 'hint')); tree.append(selected);
    }
    const children = state?.children.items ?? task.children ?? [];
    const branch = el('ul'); branch.classList.add('worker-relation-children');
    for (const child of children) { const item = el('li'); item.append(workerRow(child, '直接子 Worker')); branch.append(item); }
    selected.append(branch); body.append(tree);
    section.relationsCount = state?.children.items.length ?? 0;
    if (state) {
      body.append(el('p', `直接子 Worker：${children.length} / ${state.children.total}`, 'hint worker-relations-count'));
      if (!state.children.total) body.append(el('p', '没有直接子 Worker。', 'hint'));
      if (state.children.has_more) body.append(button(loading ? '加载中…' : '加载更多直接子 Worker', more, 'ghost worker-relations-more'));
    } else body.append(el('p', available === false ? '关系读取失败；当前显示详情内的子 Worker 摘要，可能不完整。' : 'Worker 关系加载中…', 'hint'));
    if (error) body.append(el('p', error, 'error worker-relations-error'));
    if (available === false) {
      if (state) body.append(el('p', '关系刷新失败；保留上次读取的关系与状态。', 'hint'));
      body.append(button('重试读取关系', retry, 'ghost worker-relations-retry'));
    }
    for (const control of body.querySelectorAll('.worker-relations-more, .worker-relations-retry')) control.disabled = loading;
  };
  async function more() {
    if (loading || !state?.children.has_more) return;
    const epoch = generation, previous = state;
    loading = true; error = ''; paint();
    try {
      const page = await api(`/api/worker/${task.id}/relations?after=${previous.children.cursor}&limit=${PAGE_SIZE}`, { signal: readSignal });
      if (!alive(epoch)) return;
      const known = new Set(previous.children.items.map(child => child.id));
      state = { ...page, children: { ...page.children, items: [...previous.children.items, ...page.children.items.filter(child => !known.has(child.id))] } };
    } catch (failure) {
      if (alive(epoch) && !isReadAbort(failure)) error = `加载更多关系失败：${failure.message}`;
    } finally { if (alive(epoch)) { loading = false; paint(); } }
  }
  async function retry() {
    if (loading) return;
    const epoch = generation; loading = true; error = ''; paint();
    try {
      const value = await loadWorkerRelations(task.id, { count: section.relationsCount, signal: readSignal });
      if (alive(epoch)) { state = value; available = true; }
    } catch (failure) {
      if (alive(epoch) && !isReadAbort(failure)) error = `读取关系失败：${failure.message}`;
    } finally { if (alive(epoch)) { loading = false; paint(); } }
  }
  section.bindRelations = (nextTask, options) => {
    generation++; loading = false; task = nextTask; active = options.current; readSignal = options.signal;
    paint();
  };
  section.updateRelations = (value, success) => {
    generation++; loading = false; available = success; error = '';
    if (success) state = value;
    paint();
  };
  paint(); return section;
}
