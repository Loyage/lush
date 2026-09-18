const $ = id => document.getElementById(id);
let selected = null, selectedRevision = null, busy = false, offlineError = null;
const labels = { queued:'排队', running:'运行中', waiting:'等子任务', awaiting:'等你决定', completed:'已完成', failed:'失败', cancelled:'已取消' };
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function button(text, fn) { const node = el('button', text); node.type = 'button'; node.onclick = async () => { node.disabled = true; try { await fn(); } catch (error) { $('error').textContent = error.message; } finally { node.disabled = false; } }; return node; }
function syncChildren(container, nodes) {
  const wanted = new Set(nodes);
  for (const child of [...container.children]) if (!wanted.has(child)) child.remove();
  nodes.forEach((node, index) => { if (container.children[index] !== node) container.insertBefore(node, container.children[index] || null); });
}
async function api(url, options) {
  const response = await fetch(url, options); const value = await response.json();
  if (!response.ok) throw new Error(value.error || response.statusText); return value;
}
async function action(method, params) {
  $('error').textContent = '';
  const result = await api('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({method, params}) });
  await refresh(); return result;
}
$('input-form').onsubmit = async event => {
  event.preventDefault(); const value = $('input').value; if (!value.trim()) return;
  const submit = event.currentTarget.querySelector('button'); submit.disabled = true;
  try { await action('input.submit', {content:value}); if ($('input').value === value) $('input').value = ''; }
  catch (error) { $('error').textContent = error.message; } finally { submit.disabled = false; }
};
async function detail(taskId) {
  selected = taskId;
  const task = await api(`/api/task/${taskId}`);
  if (selected !== taskId) return;
  selectedRevision = task.updated_at;
  const panel = $('detail'); panel.replaceChildren(el('h2', `#${task.id} · ${labels[task.status]}`), el('h3', task.goal));
  panel.append(el('p', `${task.role} · ${task.calls} 次调用`));
  if (task.error) panel.append(el('pre', task.error, 'error'));
  if (task.workspace) panel.append(el('pre', `${task.branch}\n${task.workspace}`));
  if (task.result) panel.append(el('pre', task.result));
  if (task.integration_error) panel.append(el('pre', task.integration_error, 'error'));
  const controls = el('div', undefined, 'actions');
  if (task.status === 'completed' && ['pending','review'].includes(task.integration)) controls.append(button(task.integration === 'review' ? '检查后重新批准合并' : '批准合并', async () => {
    if (confirm(`将 ${task.branch} 合并到 ${task.target_branch}？请先审阅代码和测试结果。`)) await action('task.merge', {id:task.id});
    await detail(task.id);
  }));
  if (['failed','cancelled'].includes(task.status)) controls.append(button('检查后重试', async () => { await action('task.retry', {id:task.id}); await detail(task.id); }));
  if (!['completed','failed','cancelled'].includes(task.status)) {
    controls.append(button('取消任务树', async () => { if (confirm('取消这个任务及所有子任务？工作区会保留。')) await action('task.cancel', {id:task.id}); await detail(task.id); }));
    const form = el('form'), input = el('textarea'); input.placeholder = '追加要求，不打断当前 agent'; input.required = true;
    form.append(input, el('button', '追加说明'));
    form.onsubmit = async event => { event.preventDefault(); const btn = form.querySelector('button'); btn.disabled = true;
      try { await action('task.message', {id:task.id, body:input.value}); input.value = ''; } catch (error) { $('error').textContent = error.message; } finally { btn.disabled = false; } };
    panel.append(form);
  }
  if (task.status === 'completed' && task.workspace && ['merged','none'].includes(task.integration)) controls.append(button('回收 worktree', async () => { await action('task.cleanup', {id:task.id}); await detail(task.id); }));
  panel.append(controls, button('刷新详情', () => detail(task.id)));
  if (task.integration !== 'none') panel.append(el('p', `合并状态：${task.integration}`));
}
async function refresh() {
  if (busy) return; busy = true;
  try {
    const data = await api('/api/snapshot');
    $('project').textContent = data.status.project; $('connection').textContent = '已连接';
    if ($('error').textContent === offlineError) $('error').textContent = '';
    offlineError = null;
    $('agents').textContent = `${data.status.agents.length} 个 agent`;
    const inputNodes = new Map([...$('inputs').children].map(node => [Number(node.dataset.id), node]));
    syncChildren($('inputs'), data.inputs.map(input => {
      const node = inputNodes.get(input.id) || el('article');
      if (!inputNodes.has(input.id)) {
        node.dataset.id = input.id; node.append(el('small'), el('p', input.content), button('查看任务', () => detail(input.task_id)));
      }
      node.querySelector('small').textContent = `#${input.id} · ${labels[input.status]}`; return node;
    }));
    const tasks = $('tasks'), taskNodes = new Map([...tasks.children].map(node => [Number(node.dataset.id), node])), ordered = [];
    const byParent = new Map();
    for (const task of data.tasks) { const key = task.parent_id || 0; if (!byParent.has(key)) byParent.set(key, []); byParent.get(key).push(task); }
    function render(parent, depth) { for (const task of byParent.get(parent) || []) {
      const node = taskNodes.get(task.id) || button('', () => detail(task.id));
      node.dataset.id = task.id; node.textContent = `#${task.id} · ${labels[task.status]} · ${task.goal}`;
      node.className = `task depth-${Math.min(depth, 4)}`; node.title = task.goal; ordered.push(node); render(task.id, depth + 1);
    } }
    render(0, 0); syncChildren(tasks, ordered);
    // Reuse keyed forms: polling must never discard a partially typed answer.
    const existing = new Map([...$('notices').children].map(node => [Number(node.dataset.id), node]));
    const forms = data.notices.filter(n => n.status === 'open').map(notice => {
      if (existing.has(notice.id)) return existing.get(notice.id);
      const form = el('form'); form.dataset.id = notice.id; form.append(el('h3', `#${notice.task_id}: ${notice.title}`), el('p', notice.body));
      const answer = el('textarea'); answer.required = true; answer.placeholder = '你的决定'; form.append(answer, el('button','回复'));
      form.append(button('忽略', () => action('notice.dismiss', {id:notice.id})));
      form.onsubmit = async event => { event.preventDefault(); const btn = form.querySelector('button'); btn.disabled = true;
        try { await action('notice.answer', {id:notice.id, answer:answer.value}); form.remove(); } catch (error) { $('error').textContent = error.message; btn.disabled = false; } }; return form;
    });
    const wanted = new Set(forms);
    for (const node of [...$('notices').children]) if (!wanted.has(node)) node.remove();
    for (const node of forms) if (node.parentNode !== $('notices')) $('notices').append(node);
    const current = data.tasks.find(task => task.id === selected);
    const editing = [...$('detail').querySelectorAll('textarea')].some(node => node.value || node === document.activeElement);
    if (current && current.updated_at !== selectedRevision && !editing) await detail(selected);
  } catch (error) { $('connection').textContent = '离线 · 自动重连'; offlineError = error.message; $('error').textContent = error.message; }
  finally { busy = false; }
}
await refresh(); setInterval(refresh, 1500);
