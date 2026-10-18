import { el, button } from './dom.js';
import { api } from './api.js';
import { workerLabel, rememberWorkers } from './worker-label.js';
import { taskTitle } from './format.js';

/** A child-creation source is current Worker or one of its actual direct children, never a project search. */
export function createChildSourcePicker({ parent, ownsPage, onChange }) {
  const node = el('div', undefined, 'worker-child-source');
  const select = el('select'); select.setAttribute('aria-label', '复制来源');
  const workers = new Map([[parent.id, parent]]);
  let cursor = 0, busy = false, disabled = false, complete = false;
  const feedback = el('p', '默认复制当前 Worker；可按需加载它已有的直接子 Worker。', 'hint'); feedback.setAttribute('role', 'status');
  function paint() {
    const previous = select.value || String(parent.id);
    rememberWorkers([...workers.values()]);
    select.replaceChildren(...[...workers.values()].map(worker => {
      const option = el('option', `${worker.id === parent.id ? '当前 Worker（默认）' : '直接子 Worker'} · ${workerLabel(worker)} ${taskTitle(worker)}`);
      option.value = String(worker.id); return option;
    }));
    select.value = previous;
  }
  const load = button('加载直接子 Worker', async () => {} , 'ghost');
  load.setAttribute('data-help', '只读取当前 Worker 的直接子项，按页继续加载；不列出兄弟、孙级或其它 Worker，不调用 Agent。');
  const host = el('span', undefined, 'help-host'); host.append(load);
  function sync() {
    select.disabled = load.disabled = busy || disabled;
    if (busy || disabled) { host.setAttribute('data-help', busy ? '正在读取直接子 Worker，请稍候。' : '创建请求正在处理，不能更改来源。'); host.tabIndex = 0; }
    else { host.removeAttribute('data-help'); host.removeAttribute('tabindex'); }
  }
  load.onclick = async () => {
    if (busy || disabled || !ownsPage()) return;
    busy = true; sync();
    const after = complete ? 0 : cursor;
    try {
      const result = await api(`/api/worker/${parent.id}/relations?after=${after}&limit=100`);
      if (!ownsPage()) return;
      const page = result.children;
      if (!Array.isArray(page?.items) || typeof page.has_more !== 'boolean'
        || page.items.some(worker => !Number.isSafeInteger(worker.id) || worker.id <= after || worker.parent_id !== parent.id)
        || (page.has_more && (!Number.isSafeInteger(page.cursor) || page.cursor <= after || page.cursor !== page.items.at(-1)?.id)))
        throw new Error('直接子 Worker 分页或归属不兼容');
      for (const worker of page.items) if (['order', 'child'].includes(worker.task_kind) && worker.execution_retired !== true) workers.set(worker.id, worker);
      cursor = page.cursor; complete = !page.has_more; paint();
      load.textContent = complete ? '重新读取直接子 Worker' : '加载更多直接子 Worker';
      feedback.textContent = `已加载 ${workers.size - 1} 个直接子 Worker${complete ? '；本次分页已读完。' : '；仍有更多子项未加载。'}复制前还会核验来源详情与父级。`;
    } catch (error) { if (ownsPage()) feedback.textContent = `子 Worker 读取失败：${error.message}；当前来源保留，可重新加载。`; }
    finally { busy = false; if (ownsPage()) sync(); }
  };
  select.onchange = onChange; paint();
  const label = el('label', undefined, 'worker-create-field'); label.append(el('span', '复制来源'), select);
  node.append(label, host, feedback);
  return { node, select, value: () => workers.get(Number(select.value)) || null,
    update(worker) { if (workers.has(worker.id)) { workers.set(worker.id, worker); paint(); } },
    setBusy(value) { disabled = value; sync(); } };
}
