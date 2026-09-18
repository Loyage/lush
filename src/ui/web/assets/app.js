const elements = {
  connection: document.querySelector('#connection'),
  refresh: document.querySelector('#refresh'),
  tree: document.querySelector('#tree'),
  treeEmpty: document.querySelector('#tree-empty'),
  selection: document.querySelector('#selection'),
  selectionName: document.querySelector('#selection-name'),
  selectionMeta: document.querySelector('#selection-meta'),
  form: document.querySelector('#task-form'),
  goal: document.querySelector('#goal'),
  submit: document.querySelector('#submit'),
  formMessage: document.querySelector('#form-message'),
  taskCard: document.querySelector('#task-card'),
  taskId: document.querySelector('#task-id'),
  taskStatus: document.querySelector('#task-status'),
  taskGoal: document.querySelector('#task-goal'),
  taskResult: document.querySelector('#task-result'),
};

const state = {
  services: [],
  selectedSid: null,
  task: null,
  taskTimer: null,
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`HTTP ${response.status}`);
  }
  if (!response.ok) throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
  return payload;
}

function connection(kind, label) {
  elements.connection.className = `connection ${kind}`;
  elements.connection.lastElementChild.textContent = label;
}

function selectedService() {
  return state.services.find((service) => service.sid === state.selectedSid) ?? null;
}

function selectService(sid) {
  state.selectedSid = sid;
  renderTree();
  renderSelection();
  elements.goal.focus();
}

function renderSelection() {
  const service = selectedService();
  const active = service?.status === 'active';
  elements.selection.classList.toggle('empty-selection', service === null);
  elements.selectionName.textContent = service === null ? '请从左侧选择' : service.name;
  elements.selectionMeta.textContent = service === null ? '' : `SID ${service.sid} · ${service.status}`;
  elements.goal.disabled = !active;
  elements.submit.disabled = !active;
}

function serviceButton(service, depth) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `service${service.sid === state.selectedSid ? ' selected' : ''}`;
  button.style.setProperty('--indent', `${depth * 22}px`);
  button.dataset.depth = String(depth);
  button.dataset.sid = String(service.sid);
  button.setAttribute('role', 'treeitem');
  button.setAttribute('aria-selected', String(service.sid === state.selectedSid));
  button.disabled = service.status !== 'active';

  const copy = document.createElement('span');
  const name = document.createElement('span');
  name.className = 'service-name';
  name.textContent = service.name;
  const id = document.createElement('span');
  id.className = 'service-id';
  id.textContent = `[${service.sid}]`;
  const detail = document.createElement('span');
  detail.className = 'service-detail';
  detail.textContent = service.goal || service.template;
  copy.append(name, id, detail);

  const running = service.agent?.running ?? 0;
  const badge = document.createElement('span');
  badge.className = `badge ${running > 0 ? 'running' : service.status}`;
  badge.textContent = running > 0 ? `${running} running` : service.status;
  button.append(copy, badge);
  button.addEventListener('click', () => selectService(service.sid));
  return button;
}

function renderTree() {
  elements.tree.replaceChildren();
  elements.treeEmpty.hidden = state.services.length > 0;
  if (state.services.length === 0) return;

  const byParent = new Map();
  const ids = new Set(state.services.map((service) => service.sid));
  for (const service of state.services) {
    const parent = service.parent_sid !== null && ids.has(service.parent_sid) ? service.parent_sid : null;
    const siblings = byParent.get(parent) ?? [];
    siblings.push(service);
    byParent.set(parent, siblings);
  }

  const visited = new Set();
  const append = (service, depth) => {
    if (visited.has(service.sid)) return;
    visited.add(service.sid);
    const node = document.createElement('div');
    node.className = 'tree-node';
    node.append(serviceButton(service, depth));
    elements.tree.append(node);
    for (const child of byParent.get(service.sid) ?? []) append(child, depth + 1);
  };
  for (const root of byParent.get(null) ?? []) append(root, 0);
  // Defensive fallback for malformed or cyclic input; Core normally makes this impossible.
  for (const service of state.services) if (!visited.has(service.sid)) append(service, 0);
}

async function loadTree({ quiet = false } = {}) {
  if (!quiet) elements.refresh.disabled = true;
  try {
    const payload = await api('/api/tree');
    state.services = payload.services;
    if (state.selectedSid !== null && selectedService() === null) state.selectedSid = null;
    renderTree();
    renderSelection();
    connection('online', 'daemon online');
  } catch (err) {
    connection('error', '连接失败');
    if (!quiet) showMessage(err.message, true);
  } finally {
    elements.refresh.disabled = false;
  }
}

function showMessage(message, error = false) {
  elements.formMessage.textContent = message;
  elements.formMessage.classList.toggle('error', error);
}

function resultText(task) {
  const value = task.error ?? task.result;
  if (value === null || value === undefined || value === '') return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function showTask(task) {
  state.task = { ...state.task, ...task };
  elements.taskCard.hidden = false;
  elements.taskId.textContent = `TASK #${state.task.id}`;
  elements.taskStatus.textContent = state.task.status;
  elements.taskStatus.className = `status ${state.task.status}`;
  elements.taskGoal.textContent = state.task.goal ?? '';
  const result = resultText(state.task);
  elements.taskResult.hidden = result === '';
  elements.taskResult.textContent = result;
}

function stopTaskPoll() {
  if (state.taskTimer !== null) window.clearTimeout(state.taskTimer);
  state.taskTimer = null;
}

async function pollTask(taskId) {
  stopTaskPoll();
  try {
    const payload = await api(`/api/tasks/${taskId}`);
    showTask(payload.task);
    if (!payload.task.finished) {
      state.taskTimer = window.setTimeout(() => pollTask(taskId), 1000);
    } else {
      showMessage(`Task #${taskId} 已结束`);
      await loadTree({ quiet: true });
    }
  } catch (err) {
    showMessage(`读取 Task #${taskId} 失败：${err.message}`, true);
  }
}

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const service = selectedService();
  const goal = elements.goal.value.trim();
  if (service === null || service.status !== 'active' || goal === '') return;

  elements.submit.disabled = true;
  showMessage('正在创建…');
  try {
    const payload = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ sid: service.sid, goal }),
    });
    showTask({ ...payload.task, goal });
    elements.goal.value = '';
    showMessage(`Task #${payload.task.id} 已在后台启动`);
    await loadTree({ quiet: true });
    await pollTask(payload.task.id);
  } catch (err) {
    showMessage(err.message, true);
  } finally {
    elements.submit.disabled = selectedService()?.status !== 'active';
  }
});

elements.refresh.addEventListener('click', () => loadTree());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) loadTree({ quiet: true });
});

await loadTree();
window.setInterval(() => loadTree({ quiet: true }), 2500);
