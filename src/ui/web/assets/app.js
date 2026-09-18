const TASK_LIMIT = 500;
const ACTIVE_STATUSES = ['created', 'running', 'waiting'];

const elements = {
  connection: document.querySelector('#connection'),
  refresh: document.querySelector('#refresh'),
  tabs: [...document.querySelectorAll('.tab')],
  servicesView: document.querySelector('#services-view'),
  tasksView: document.querySelector('#tasks-view'),
  noticesView: document.querySelector('#notices-view'),
  tree: document.querySelector('#tree'),
  treeEmpty: document.querySelector('#tree-empty'),
  taskScope: document.querySelector('#task-scope'),
  taskStatus: document.querySelector('#task-status'),
  taskList: document.querySelector('#task-list'),
  tasksEmpty: document.querySelector('#tasks-empty'),
  tasksNote: document.querySelector('#tasks-note'),
  noticeStatus: document.querySelector('#notice-status'),
  noticeList: document.querySelector('#notice-list'),
  noticesEmpty: document.querySelector('#notices-empty'),
  noticeCount: document.querySelector('#notice-count'),
  createPanel: document.querySelector('#create-panel'),
  servicePanel: document.querySelector('#service-panel'),
  treePanel: document.querySelector('#tree-panel'),
  noticePanel: document.querySelector('#notice-panel'),
  noticeHint: document.querySelector('#notice-hint'),
  noticeDetail: document.querySelector('#notice-detail'),
  noticeId: document.querySelector('#notice-id'),
  noticeKind: document.querySelector('#notice-kind'),
  noticeState: document.querySelector('#notice-state'),
  noticeReporter: document.querySelector('#notice-reporter'),
  noticeSubject: document.querySelector('#notice-subject'),
  noticeText: document.querySelector('#notice-text'),
  noticeForm: document.querySelector('#notice-form'),
  noticeFields: document.querySelector('#notice-fields'),
  noticeMessage: document.querySelector('#notice-message'),
  noticeSubmit: document.querySelector('#notice-submit'),
  noticeAnswer: document.querySelector('#notice-answer'),
  noticeDismiss: document.querySelector('#notice-dismiss'),
  selection: document.querySelector('#selection'),
  selectionName: document.querySelector('#selection-name'),
  selectionMeta: document.querySelector('#selection-meta'),
  form: document.querySelector('#task-form'),
  goal: document.querySelector('#goal'),
  submit: document.querySelector('#submit'),
  formMessage: document.querySelector('#form-message'),
  taskNew: document.querySelector('#task-new'),
  taskParent: document.querySelector('#task-parent'),
  taskCancel: document.querySelector('#task-cancel'),
  taskDelete: document.querySelector('#task-delete'),
  taskHint: document.querySelector('#task-hint'),
  taskDetail: document.querySelector('#task-detail'),
  detailId: document.querySelector('#detail-id'),
  detailStatus: document.querySelector('#detail-status'),
  detailGoal: document.querySelector('#detail-goal'),
  detailMeta: document.querySelector('#detail-meta'),
  detailResult: document.querySelector('#detail-result'),
  taskTree: document.querySelector('#task-tree'),
  serviceHint: document.querySelector('#service-hint'),
  serviceView: document.querySelector('#service-view'),
  serviceDescription: document.querySelector('#service-description'),
  serviceTemplates: document.querySelector('#service-templates'),
  serviceTemplatesCount: document.querySelector('#service-templates-count'),
  servicePrompt: document.querySelector('#service-prompt'),
};

const state = {
  view: 'services',
  services: [],
  selectedSid: null,
  serviceView: null,
  serviceViewSid: null,
  tasks: [],
  selectedTaskId: null,
  taskTree: null,
  notices: [],
  selectedNoticeId: null,
  notice: null,
  noticeSignature: null,
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // A non-JSON body means the error came from far outside the API surface.
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function connection(kind, label) {
  elements.connection.className = `connection ${kind}`;
  elements.connection.lastElementChild.textContent = label;
}

function showMessage(message, error = false) {
  elements.formMessage.textContent = message;
  elements.formMessage.classList.toggle('error', error);
}

function stamp(value) {
  if (value === null || value === undefined) return '-';
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? String(value) : time.toLocaleString('zh-CN', { hour12: false });
}

function resultText(value) {
  if (value === null || value === undefined || value === '') return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function subtreeSize(task) {
  return 1 + (task.children ?? []).reduce((total, child) => total + subtreeSize(child), 0);
}

// ── Services ───────────────────────────────────────────────────────────────

function selectedService() {
  return state.services.find((service) => service.sid === state.selectedSid) ?? null;
}

function serviceName(sid) {
  const service = state.services.find((row) => row.sid === sid);
  return service === undefined ? `sid ${sid}` : `${service.name}[${sid}]`;
}

function selectService(sid) {
  state.selectedSid = sid;
  renderServiceTree();
  renderSelection();
  if (selectedService()?.status === 'active') elements.goal.focus();
  loadServiceView().catch((err) => showMessage(err.message, true));
}

function renderSelection() {
  const service = selectedService();
  elements.selection.classList.toggle('empty-selection', service === null);
  elements.selectionName.textContent = service === null ? '请从左侧选择' : service.name;
  elements.selectionMeta.textContent = service === null ? '' : `SID ${service.sid} · ${service.status}`;
  const active = service?.status === 'active';
  elements.goal.disabled = !active;
  elements.submit.disabled = !active || state.selectedSid === null;
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

function renderServiceTree() {
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

// ── Task list (sidebar) ────────────────────────────────────────────────────

function taskScopeParam() {
  return elements.taskScope.value === 'all' ? null : elements.taskScope.value;
}

function taskStatusParam() {
  return elements.taskStatus.value === '' ? null : elements.taskStatus.value;
}

/**
 * The sidebar shows a forest built from the flat `task.list` rows: tasks whose
 * parent is not in the fetched window become roots, so a filtered list still
 * renders as a tree instead of losing nodes.
 */
function taskForest() {
  const byParent = new Map();
  const ids = new Set(state.tasks.map((task) => task.id));
  for (const task of state.tasks) {
    const parent = task.parent_task_id !== null && ids.has(task.parent_task_id) ? task.parent_task_id : null;
    const siblings = byParent.get(parent) ?? [];
    siblings.push(task);
    byParent.set(parent, siblings);
  }
  return byParent;
}

function taskRow(task, depth, childCount) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `task-row${task.id === state.selectedTaskId ? ' selected' : ''}`;
  button.style.setProperty('--indent', `${depth * 18}px`);
  button.setAttribute('role', 'treeitem');
  button.setAttribute('aria-selected', String(task.id === state.selectedTaskId));

  const dot = document.createElement('span');
  dot.className = `status-dot ${task.status}`;
  dot.setAttribute('aria-hidden', 'true');

  const copy = document.createElement('span');
  const title = document.createElement('span');
  title.className = 'task-row-title';
  title.textContent = `#${task.id} ${task.goal ?? ''}`;
  const meta = document.createElement('span');
  meta.className = 'task-row-meta';
  const children = childCount > 0 ? ` · 子 ${childCount}` : '';
  meta.textContent = `${serviceName(task.sid)} · ${task.status}${children}`;
  copy.append(title, meta);

  button.replaceChildren(dot, copy);
  button.title = task.goal ?? '';
  button.addEventListener('click', () => selectTask(task.id));
  return button;
}

function renderTaskList() {
  elements.taskList.replaceChildren();
  elements.tasksEmpty.hidden = state.tasks.length > 0;
  elements.tasksNote.hidden = state.tasks.length < TASK_LIMIT;
  elements.tasksNote.textContent = state.tasks.length < TASK_LIMIT
    ? ''
    : `只显示最近 ${TASK_LIMIT} 条 Task，请用上方筛选缩小范围。`;
  if (state.tasks.length === 0) return;

  const byParent = taskForest();
  const visited = new Set();
  const append = (task, depth) => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    const node = document.createElement('div');
    node.className = 'tree-node';
    node.append(taskRow(task, depth, (byParent.get(task.id) ?? []).length));
    elements.taskList.append(node);
    for (const child of byParent.get(task.id) ?? []) append(child, depth + 1);
  };
  for (const root of byParent.get(null) ?? []) append(root, 0);
  for (const task of state.tasks) if (!visited.has(task.id)) append(task, 0);
}

// ── Task tree (detail panel) ───────────────────────────────────────────────

function taskNode(task, depth) {
  const node = document.createElement('div');
  node.className = 'task-tree-node';
  node.style.setProperty('--indent', `${depth * 20}px`);

  const row = document.createElement('button');
  row.type = 'button';
  row.className = `task-node${task.id === state.selectedTaskId ? ' selected' : ''}`;
  row.dataset.depth = String(depth);
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-selected', String(task.id === state.selectedTaskId));
  row.title = task.goal ?? '';

  const head = document.createElement('span');
  head.className = 'task-node-head';
  const id = document.createElement('span');
  id.className = 'task-node-id';
  id.textContent = `#${task.id}`;
  const where = document.createElement('span');
  where.className = 'task-node-service';
  where.textContent = `${task.service_name ?? serviceName(task.sid)}[${task.sid}]`;
  const status = document.createElement('span');
  status.className = `status ${task.status}`;
  status.textContent = task.status;
  head.append(id, where, status);
  const goal = document.createElement('span');
  goal.className = 'task-node-goal';
  goal.textContent = task.goal ?? '';
  row.append(head, goal);
  row.addEventListener('click', () => selectTask(task.id));
  node.append(row);

  for (const child of task.children ?? []) node.append(taskNode(child, depth + 1));
  return node;
}

function renderTaskTree() {
  elements.taskTree.replaceChildren();
  const task = state.taskTree;
  if (task === null) return;
  elements.taskTree.append(taskNode(task, 0));
}

function renderTaskDetail() {
  const task = state.taskTree;
  const has = task !== null;
  elements.taskHint.hidden = has;
  elements.taskDetail.hidden = !has;
  elements.taskTree.hidden = !has;
  elements.taskParent.hidden = !has || task.parent_task_id === null;
  elements.taskCancel.disabled = !has || !ACTIVE_STATUSES.includes(task.status);
  elements.taskDelete.disabled = !has || ACTIVE_STATUSES.includes(task.status);
  if (!has) {
    elements.taskTree.replaceChildren();
    return;
  }

  elements.detailId.textContent = `#${task.id}`;
  elements.detailStatus.textContent = task.status;
  elements.detailStatus.className = `status ${task.status}`;
  elements.detailGoal.textContent = task.goal ?? '';
  const meta = [
    `service ${task.service_name ?? `sid ${task.sid}`}[${task.sid}]`,
    `父 ${task.parent_task_id === null ? '-' : `#${task.parent_task_id}`}`,
    `创建 ${stamp(task.created_at)}`,
    `结束 ${stamp(task.finished_at)}`,
    `子树 ${subtreeSize(task)} 个 task`,
  ];
  elements.detailMeta.textContent = meta.join(' · ');
  const outcome = resultText(task.error ?? task.result);
  elements.detailResult.hidden = outcome === '';
  elements.detailResult.textContent = outcome;
  elements.detailResult.classList.toggle('error', task.error !== null && task.error !== undefined);
}

// ── Notices (agent → user) ──────────────────────────────────────────────

const NOTICE_KIND_LABEL = { report: '汇报', decision: '决策', blocked: '受阻' };
const NOTICE_DOT = { open: 'waiting', answered: 'completed', dismissed: 'cancelled' };

function noticeStatusParam() {
  return elements.noticeStatus.value === '' ? null : elements.noticeStatus.value;
}

function noticeRow(notice) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `notice-row${notice.id === state.selectedNoticeId ? ' selected' : ''}`;
  button.setAttribute('role', 'listitem');

  const dot = document.createElement('span');
  dot.className = `status-dot ${NOTICE_DOT[notice.status] ?? 'created'}`;
  dot.setAttribute('aria-hidden', 'true');

  const copy = document.createElement('span');
  const title = document.createElement('span');
  title.className = 'notice-row-title';
  title.textContent = `#${notice.id} ${notice.title}`;
  const meta = document.createElement('span');
  meta.className = 'notice-row-meta';
  const where = notice.task_id === null ? `sid ${notice.sid}` : `task#${notice.task_id} ${serviceName(notice.sid)}`;
  meta.textContent = `${NOTICE_KIND_LABEL[notice.kind] ?? notice.kind} · ${notice.status} · ${where}`;
  copy.append(title, meta);

  button.replaceChildren(dot, copy);
  button.title = notice.title;
  button.addEventListener('click', () => selectNotice(notice.id));
  return button;
}

function renderNoticeList() {
  elements.noticeList.replaceChildren();
  elements.noticesEmpty.hidden = state.notices.length > 0;
  for (const notice of state.notices) elements.noticeList.append(noticeRow(notice));
  const open = state.notices.filter((notice) => notice.status === 'open').length;
  elements.noticeCount.hidden = open === 0;
  elements.noticeCount.textContent = String(open);
}

/** One input for one declared field; the shape mirrors `core/notices.js`. */
function noticeFieldInput(field) {
  const wrap = document.createElement('label');
  wrap.className = 'notice-field';
  const label = document.createElement('span');
  label.className = 'notice-field-label';
  label.textContent = field.required ? `${field.label} *` : field.label;

  let input;
  if (field.type === 'textarea') {
    input = document.createElement('textarea');
    input.rows = 4;
  } else if (field.type === 'choice') {
    input = document.createElement('select');
    if (!field.required) input.append(new Option('（不填）', ''));
    for (const option of field.options) input.append(new Option(option, option));
  } else if (field.type === 'boolean') {
    input = document.createElement('input');
    input.type = 'checkbox';
  } else {
    input = document.createElement('input');
    input.type = 'text';
  }
  input.dataset.field = field.name;
  input.id = `notice-field-${field.name}`;
  if (field.type === 'boolean') {
    input.checked = field.default === true;
    wrap.classList.add('notice-field-check');
    wrap.append(input, label);
  } else {
    if (field.default !== undefined) input.value = field.default;
    wrap.append(label, input);
  }
  return wrap;
}

function renderNoticeFields(notice) {
  elements.noticeFields.replaceChildren();
  if (notice.fields.length === 0) {
    const wrap = document.createElement('label');
    wrap.className = 'notice-field';
    const label = document.createElement('span');
    label.className = 'notice-field-label';
    label.textContent = '回答';
    const input = document.createElement('textarea');
    input.rows = 4;
    input.id = 'notice-field-text';
    input.dataset.field = 'text';
    wrap.append(label, input);
    elements.noticeFields.append(wrap);
    return;
  }
  for (const field of notice.fields) elements.noticeFields.append(noticeFieldInput(field));
}

/**
 * `signature` guards the input elements: the page polls every 2.5s, and
 * rebuilding the form while the user is typing would wipe their answer.
 */
function renderNoticeDetail({ force = false } = {}) {
  const notice = state.notice;
  const has = notice !== null;
  elements.noticeHint.hidden = has;
  elements.noticeDetail.hidden = !has;
  if (!has) {
    state.noticeSignature = null;
    return;
  }

  const signature = `${notice.id}:${notice.status}:${notice.answered_at ?? ''}`;
  const changed = force || signature !== state.noticeSignature;
  state.noticeSignature = signature;

  elements.noticeId.textContent = `#${notice.id}`;
  elements.noticeKind.textContent = NOTICE_KIND_LABEL[notice.kind] ?? notice.kind;
  elements.noticeKind.className = `badge ${notice.kind}`;
  elements.noticeState.textContent = notice.status;
  elements.noticeState.className = `status ${notice.status}`;
  const where = notice.task_id === null
    ? `service ${notice.service_name}[${notice.sid}]`
    : `task#${notice.task_id} ${notice.service_name}[${notice.sid}]`;
  const goal = notice.task_goal ? ` · ${notice.task_goal}` : '';
  elements.noticeReporter.textContent = `${where}${goal}${notice.wait ? ' · 上报者正在等待' : ''}`;
  elements.noticeSubject.textContent = notice.title;
  elements.noticeText.textContent = notice.body ?? '';
  elements.noticeText.hidden = (notice.body ?? '') === '';

  if (changed) {
    renderNoticeFields(notice);
    elements.noticeMessage.textContent = '';
    elements.noticeMessage.classList.remove('error');
  }

  const open = notice.status === 'open';
  elements.noticeForm.hidden = !open;
  elements.noticeSubmit.disabled = !open;
  elements.noticeDismiss.disabled = !open;
  for (const input of elements.noticeFields.querySelectorAll('input, textarea, select')) {
    input.disabled = !open;
  }

  const settled = notice.answer !== null || notice.note !== null;
  elements.noticeAnswer.hidden = !settled;
  if (settled) {
    elements.noticeAnswer.textContent = notice.answer !== null
      ? JSON.stringify(notice.answer, null, 2)
      : `忽略原因：${notice.note}`;
  }
}

/** The user's filled-in answer, keyed the way the reporter declared it. */
function collectAnswer(notice) {
  const answer = {};
  for (const input of elements.noticeFields.querySelectorAll('[data-field]')) {
    const name = input.dataset.field;
    if (name === 'text') {
      if (input.value !== '') answer.text = input.value;
      continue;
    }
    const field = notice.fields.find((item) => item.name === name);
    if (field?.type === 'boolean') {
      answer[name] = input.checked;
      continue;
    }
    if (input.value !== '') answer[name] = input.value;
  }
  return answer;
}

async function loadNotices() {
  const params = new URLSearchParams({ limit: '200' });
  const status = noticeStatusParam();
  if (status !== null) params.set('status', status);
  const payload = await api(`/api/notices?${params}`);
  state.notices = payload.notices;
  renderNoticeList();
}

async function loadNotice() {
  const noticeId = state.selectedNoticeId;
  if (noticeId === null) {
    state.notice = null;
    renderNoticeDetail();
    return;
  }
  let payload;
  try {
    payload = await api(`/api/notices/${noticeId}`);
  } catch (err) {
    if (err.status === 404) {
      state.selectedNoticeId = null;
      state.notice = null;
      renderNoticeDetail();
      renderNoticeList();
      return;
    }
    throw err;
  }
  if (state.selectedNoticeId !== noticeId) return;
  state.notice = payload.notice;
  renderNoticeDetail();
}

async function selectNotice(noticeId) {
  state.selectedNoticeId = noticeId;
  renderNoticeList();
  try {
    await loadNotice();
  } catch (err) {
    showMessage(err.message, true);
  }
}

// ── Service capability panel ───────────────────────────────────────────────

/**
 * One service's three read surfaces (`service.view`): its capability-boundary
 * description, the child templates it may still create, and the call prompt its
 * tasks run with. Read-only — creating a task stays in the panel above.
 */
function templateCard(template) {
  const card = document.createElement('article');
  card.className = 'template';

  const head = document.createElement('div');
  head.className = 'template-head';
  const name = document.createElement('span');
  name.className = 'template-name';
  name.textContent = template.name;
  head.append(name);
  if (template.singleton) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'singleton';
    head.append(badge);
  }

  const description = document.createElement('p');
  description.className = 'template-description';
  description.textContent = template.description ?? '';

  const construct = document.createElement('details');
  construct.className = 'template-construct';
  const summary = document.createElement('summary');
  summary.textContent = '构造方式（construct_prompt）';
  const prompt = document.createElement('pre');
  prompt.textContent = template.construct_prompt ?? '';
  construct.append(summary, prompt);

  card.append(head, description, construct);
  return card;
}

function renderServiceView() {
  const view = state.serviceView;
  const has = view !== null;
  elements.serviceHint.hidden = has;
  elements.serviceView.hidden = !has;
  if (!has) {
    elements.serviceDescription.textContent = '';
    elements.serviceTemplates.replaceChildren();
    elements.servicePrompt.textContent = '';
    return;
  }

  const description = view.description ?? '';
  elements.serviceDescription.textContent = description;
  elements.serviceDescription.hidden = description === '';

  const templates = view.available_child_templates ?? [];
  elements.serviceTemplatesCount.textContent = String(templates.length);
  elements.serviceTemplates.replaceChildren();
  if (templates.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty template-empty';
    empty.textContent = '当前没有可创建的子 Service（叶子节点，或 singleton 名额已被占用）。';
    elements.serviceTemplates.append(empty);
  }
  for (const template of templates) elements.serviceTemplates.append(templateCard(template));
  elements.servicePrompt.textContent = view.call_prompt ?? '';
}

/** Re-fetch the selected node's view; re-render only when it actually changed. */
async function loadServiceView() {
  const sid = state.selectedSid;
  if (sid === null) {
    state.serviceView = null;
    state.serviceViewSid = null;
    renderServiceView();
    return;
  }
  const payload = await api(`/api/services/${sid}/view`);
  if (state.selectedSid !== sid) return;
  if (state.serviceViewSid === sid && JSON.stringify(state.serviceView) === JSON.stringify(payload.service)) return;
  state.serviceView = payload.service;
  state.serviceViewSid = sid;
  renderServiceView();
}

// ── Loading ────────────────────────────────────────────────────────────────

async function loadServices() {
  const payload = await api('/api/tree');
  state.services = payload.services;
  if (state.selectedSid !== null && selectedService() === null) state.selectedSid = null;
  renderServiceTree();
  renderSelection();
}

async function loadTasks() {
  const params = new URLSearchParams({ limit: String(TASK_LIMIT) });
  const scope = taskScopeParam();
  const status = taskStatusParam();
  if (scope !== null) params.set('roots', scope);
  if (status !== null) params.set('status', status);
  const payload = await api(`/api/tasks?${params}`);
  state.tasks = payload.tasks;
  renderTaskList();
}

async function loadTaskTree() {
  const taskId = state.selectedTaskId;
  if (taskId === null) return;
  let payload;
  try {
    payload = await api(`/api/tasks/${taskId}/tree`);
  } catch (err) {
    // The task was deleted (here or through the CLI): drop the dead selection.
    if (err.status === 404) {
      state.selectedTaskId = null;
      state.taskTree = null;
      renderTaskDetail();
      renderTaskList();
      return;
    }
    throw err;
  }
  if (state.selectedTaskId !== taskId) return;
  state.taskTree = payload.task;
  renderTaskDetail();
  renderTaskTree();
}

async function selectTask(taskId) {
  state.selectedTaskId = taskId;
  renderTaskList();
  try {
    await loadTaskTree();
  } catch (err) {
    showMessage(err.message, true);
  }
}

async function refresh({ quiet = false } = {}) {
  if (!quiet) elements.refresh.disabled = true;
  try {
    await loadServices();
    await loadServiceView();
    if (state.view === 'tasks') await loadTasks();
    await loadTaskTree();
    await loadNotices();
    await loadNotice();
    connection('online', 'daemon online');
  } catch (err) {
    connection('error', '连接失败');
    if (!quiet) showMessage(err.message, true);
  } finally {
    elements.refresh.disabled = false;
  }
}

// ── View switching and actions ─────────────────────────────────────────────

function setView(view) {
  const changed = state.view !== view;
  state.view = view;
  for (const tab of elements.tabs) {
    const active = tab.dataset.view === view;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  elements.servicesView.hidden = view !== 'services';
  elements.tasksView.hidden = view !== 'tasks';
  elements.noticesView.hidden = view !== 'notices';
  // The right column mirrors the sidebar selection: 服务 shows the create form
  // plus the selected service's capabilities, 任务 shows the selected task's
  // detail (create/service would push it below the fold), Notice its own form.
  elements.createPanel.hidden = view !== 'services';
  elements.servicePanel.hidden = view !== 'services';
  elements.treePanel.hidden = view !== 'tasks';
  elements.noticePanel.hidden = view !== 'notices';
  // A panel swap can leave the page scrolled past the new first screen.
  if (changed) window.scrollTo({ top: 0 });
  if (view === 'tasks') {
    loadTasks().catch((err) => showMessage(err.message, true));
  }
  if (view === 'notices') {
    loadNotices().catch((err) => showMessage(err.message, true));
  }
}

for (const tab of elements.tabs) tab.addEventListener('click', () => setView(tab.dataset.view));
elements.taskNew.addEventListener('click', () => {
  // The create form lives in the 服务 view; one click gets there and the
  // selected service (kept across views) is already filled in.
  setView('services');
  if (selectedService()?.status === 'active') elements.goal.focus();
});
elements.taskScope.addEventListener('change', () => {
  loadTasks().catch((err) => showMessage(err.message, true));
});
elements.taskStatus.addEventListener('change', () => {
  loadTasks().catch((err) => showMessage(err.message, true));
});
elements.noticeStatus.addEventListener('change', () => {
  loadNotices().catch((err) => showMessage(err.message, true));
});
elements.refresh.addEventListener('click', () => refresh());

elements.noticeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const notice = state.notice;
  if (notice === null || notice.status !== 'open') return;
  const answer = collectAnswer(notice);
  elements.noticeSubmit.disabled = true;
  elements.noticeMessage.textContent = '正在提交…';
  elements.noticeMessage.classList.remove('error');
  try {
    const payload = await api(`/api/notices/${notice.id}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answer }),
    });
    state.notice = payload.notice;
    state.noticeSignature = null;
    renderNoticeDetail();
    await loadNotices();
    await loadTaskTree();
  } catch (err) {
    elements.noticeMessage.textContent = err.message;
    elements.noticeMessage.classList.add('error');
    renderNoticeDetail();
  }
});

elements.noticeDismiss.addEventListener('click', async () => {
  const notice = state.notice;
  if (notice === null || notice.status !== 'open') return;
  const reason = window.prompt(`忽略 notice #${notice.id}？可填写原因（留空即无）：`, '');
  if (reason === null) return;
  elements.noticeDismiss.disabled = true;
  try {
    const payload = await api(`/api/notices/${notice.id}/dismiss`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason === '' ? null : reason }),
    });
    state.notice = payload.notice;
    state.noticeSignature = null;
    renderNoticeDetail();
    await loadNotices();
    await loadTaskTree();
  } catch (err) {
    showMessage(err.message, true);
    renderNoticeDetail();
  }
});

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
    elements.goal.value = '';
    showMessage(`Task #${payload.task.id} 已在后台启动`);
    setView('tasks');
    state.selectedTaskId = payload.task.id;
    await loadTasks();
    await loadTaskTree();
  } catch (err) {
    showMessage(err.message, true);
  } finally {
    renderSelection();
  }
});

elements.taskParent.addEventListener('click', () => {
  const parent = state.taskTree?.parent_task_id;
  if (parent !== null && parent !== undefined) selectTask(parent);
});

elements.taskCancel.addEventListener('click', async () => {
  const task = state.taskTree;
  if (task === null) return;
  const size = subtreeSize(task);
  const extra = size > 1 ? `及其 ${size - 1} 个后代 task ` : '';
  if (!window.confirm(`取消 task #${task.id} ${extra}？正在运行的 agent 会被中断。`)) return;
  elements.taskCancel.disabled = true;
  try {
    const payload = await api(`/api/tasks/${task.id}/cancel`, { method: 'POST' });
    state.taskTree = payload.task;
    renderTaskDetail();
    renderTaskTree();
    showMessage(`Task #${task.id} 已取消`);
    if (state.view === 'tasks') await loadTasks();
  } catch (err) {
    showMessage(err.message, true);
    renderTaskDetail();
  }
});

elements.taskDelete.addEventListener('click', async () => {
  const task = state.taskTree;
  if (task === null) return;
  const size = subtreeSize(task);
  const extra = size > 1 ? `及其 ${size - 1} 个后代 task ` : '';
  if (!window.confirm(`删除 task #${task.id} ${extra}的记录？历史消息与调用记录会保留。`)) return;
  elements.taskDelete.disabled = true;
  try {
    await api(`/api/tasks/${task.id}/delete`, {
      method: 'POST',
      body: JSON.stringify({ recursive: true }),
    });
    const parentId = task.parent_task_id;
    state.selectedTaskId = parentId;
    state.taskTree = null;
    renderTaskDetail();
    renderTaskList();
    showMessage(`Task #${task.id} 已删除`);
    if (state.view === 'tasks') await loadTasks();
    if (parentId !== null) await loadTaskTree();
  } catch (err) {
    showMessage(err.message, true);
    renderTaskDetail();
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh({ quiet: true });
});

setView(state.view);
await refresh();
window.setInterval(() => refresh({ quiet: true }), 2500);
