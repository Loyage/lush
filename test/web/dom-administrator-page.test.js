import { test, expect } from 'bun:test';
import { installDom, dialogButton, dialogText, deepText } from '../dom-stub.js';
import { until } from '../helpers.js';
import { initComposer } from '../../src/ui/web/assets/composer.js';
import { valetLifecycleControls } from '../../src/ui/web/assets/valet-actions.js';
import { renderManagementState, renderManagementFailure } from '../../src/ui/web/assets/management-state.js';
import { closeDialog } from '../../src/ui/web/assets/dialog.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';
import { createDeviceValetPage } from '../../src/ui/web/assets/device-valet-page.js';
const find = (root, title) => root.querySelectorAll('button').find(node => node.textContent === title);
const choice = root => root.querySelector('.project-elevation-label').querySelector('input');
const storageText = storage => Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index))).join('\n');

// UI contract only; real password/Host/native execution remains in administrator-runtime.test.js.
test('project Valet input: ordinary default, one-input password elevation, unknown receipt and next-input ordinary', async () => {
  const passwordCanary = 'isolated-test-password-7A', ordinary = [], elevated = [], drafts = new Map();
  let passwordAccepted = false, receiptFound = false, lastUnknown = null;
  const task = { id: 17, worker_number: 'V9', role: 'manager', task_kind: 'management', status: 'completed',
    management: { version: 1, can_append: true, state: 'idle', enabled: false, origin: 'input', authority: { mode: 'administrator', scope: 'current_project' } } };
  const receipt = (draft, authority = 'ordinary') => {
    draft.dispatch = { kind: 'management', state: 'succeeded', worker_id: task.id, worker_number: task.worker_number, authority, conditions: [] };
    return { management: true, task, draft_id: draft.id, draft_number: draft.draft_number, revision: draft.revision, dispatch: draft.dispatch, instruction: draft.content };
  };
  const dom = installDom({ fetch: async (url, options = {}) => {
    const path = new URL(url, 'http://fixture.invalid').pathname;
    if (path.endsWith('/api/input-parents')) return Response.json({ items: [] });
    if (path.endsWith('/api/worker/17')) return Response.json(task);
    if (path.endsWith('/api/inputs')) return Response.json({ items: [...drafts.values()].filter(row => !row.dispatch), next_cursor: null });
    const match = /\/api\/input\/draft\/(\d+)$/.exec(path);
    if (match) return Response.json(drafts.get(Number(match[1])));
    if (path.endsWith('/api/action')) {
      const body = JSON.parse(options.body), p = body.params; ordinary.push(body);
      if (body.method === 'draft.add') {
        const id = drafts.size + 1, draft = { ...p, kind: 'draft', id, draft_number: id, revision: 1, status: 'draft', branch: null, parent_id: null, references: [], conditions: [], exclusive: false, target_worker_number: p.target_id ? 'V9' : null };
        drafts.set(id, draft); return Response.json(draft);
      }
      if (body.method === 'draft.update') { const draft = drafts.get(p.id); Object.assign(draft, p, { revision: draft.revision + 1 }); return Response.json(draft); }
      if (body.method === 'management.submit') return Response.json(receipt(drafts.get(p.draft_id)));
      return Response.json(task);
    }
    if (path.endsWith('/api/management/elevate')) {
      const body = JSON.parse(options.body);
      expect(Object.keys(body).sort()).toEqual(['confirm', 'definition', 'password']); expect(body.confirm).toBe(true);
      expect(body.password).toBe(passwordCanary); elevated.push(structuredClone(body.definition));
      if (!passwordAccepted) return Response.json({ code: 'elevation_password_rejected', execution: 'not_started' }, { status: 403 });
      if (body.definition.instruction === 'append unknown') { lastUnknown = structuredClone(body.definition); throw Error(passwordCanary); }
      return Response.json(receipt(drafts.get(body.definition.draft_id), 'administrator'));
    }
    if (path.endsWith('/api/management/elevation-receipt')) return Response.json(receiptFound
      ? { version: 1, found: true, definition: lastUnknown, ...receipt(drafts.get(lastUnknown.draft_id), 'administrator') } : { version: 1, found: false });
    throw Error('unexpected isolated UI route: ' + path);
  } });
  resetUiState(); ui.view = { id: 'overview' }; ui.lastSnapshot = { status: { project: '/isolated/elevation-project' } }; dom.location.pathname = '/p/1234567890abcdef/';
  const navigation = registerNavigation({ refresh: async () => {} });
  try {
    const input = dom.node('input'), form = dom.node('input-form'), advanced = dom.node('composer-management-settings');
    input.tagName = 'TEXTAREA'; form.insertBefore(input, null); dom.node('composer-shell').insertBefore(form, null); form.insertBefore(advanced, null);
    await initComposer(); await dom.node('composer-menu-management').onclick();
    expect(choice(form).checked).toBe(false); expect(advanced.hidden).toBe(true);
    input.value = 'ordinary first'; input.oninput(); await form.onsubmit({ preventDefault() {} });
    expect(ordinary.filter(call => call.method === 'management.submit')).toHaveLength(1); expect(elevated).toHaveLength(0);
    input.value = '  first elevated\n exact whitespace  '; input.oninput(); await ui.inputEditor.detail();
    expect(ui.inputEditor.inDetail).toBe(true); expect(advanced.hidden).toBe(false);
    choice(form).checked = true; choice(form).onchange(); expect(deepText(advanced)).toContain('不管理其他项目');
    let opening = form.onsubmit({ preventDefault() {} }); await until(() => dialogButton(dom, '验证密码并执行这一条'));
    let secret = dom.node('modal').querySelector('.project-elevation-password'); secret.value = passwordCanary;
    expect(secret.getAttribute('autocomplete')).toBe('current-password');
    input.value = '  amended first\n exact whitespace  '; input.oninput(); await opening;
    expect(secret.value).toBe(''); expect(elevated).toHaveLength(0);
    opening = form.onsubmit({ preventDefault() {} }); await until(() => dialogButton(dom, '验证密码并执行这一条'));
    expect(dialogText(dom)).toContain('创建管家并执行以下首条指令'); expect(dialogText(dom)).toContain('current_project');
    expect(dialogText(dom)).toContain('  amended first\n exact whitespace  ');
    secret = dom.node('modal').querySelector('.project-elevation-password'); secret.value = passwordCanary;
    await dialogButton(dom, '验证密码并执行这一条').onclick(); expect(dialogText(dom)).toContain('密码验证未通过'); expect(secret.value).toBe('');
    passwordAccepted = true; secret.value = passwordCanary;
    expect(dialogButton(dom, '验证密码并执行这一条').classList.contains('agent-call')).toBe(true);
    await dialogButton(dom, '验证密码并执行这一条').onclick(); await opening;
    expect(elevated[1]).toMatchObject({ kind: 'submit', mode: 'administrator', scope: 'current_project', instruction: '  amended first\n exact whitespace  ', draft_id: 2, expected_revision: 2 });
    expect(ui.composerElevated).toBe(false); expect(input.value).toBe('');
    expect(storageText(dom.localStorage) + storageText(dom.sessionStorage)).not.toContain(passwordCanary);

    ui.view = { id: 'task', key: 'task:17' }; ui.selected = task.id;
    const root = dom.node('detail'); root.replaceChildren(valetLifecycleControls(task)); await find(root, '追加输入').onclick();
    input.value = 'append unknown'; input.oninput(); await ui.inputEditor.detail();
    expect(choice(form).checked).toBe(false); choice(form).checked = true; choice(form).onchange();
    opening = form.onsubmit({ preventDefault() {} }); await until(() => dialogButton(dom, '验证密码并执行这一条'));
    expect(dialogText(dom)).toContain('V9 · ID 17');
    secret = dom.node('modal').querySelector('.project-elevation-password'); secret.value = passwordCanary;
    await dialogButton(dom, '验证密码并执行这一条').onclick();
    expect(secret.value).toBe(''); expect(dialogText(dom)).not.toContain(passwordCanary); expect(dialogButton(dom, '验证密码并执行这一条').disabled).toBe(true);
    closeDialog(); await opening;
    const count = elevated.length; expect(dom.node('draft-commit').disabled).toBe(true);
    await find(form, '只读核对提权提交').onclick(); expect(deepText(form)).toContain('继续保留未知'); expect(elevated).toHaveLength(count);
    receiptFound = true; await find(form, '只读核对提权提交').onclick();
    expect(elevated).toHaveLength(count); expect(storageText(dom.sessionStorage)).not.toContain(passwordCanary);
    const state = renderManagementState(task); expect(deepText(state)).toContain('管理员 · 仅当前项目／本条');
    expect(state.querySelector('.management-audit-details').open).not.toBe(true);
    const failure = renderManagementFailure({ ...task, management: { ...task.management, state: 'unknown', first_failure: { receipt_id: 123, detail: 'original safe handler failure' } } });
    expect(deepText(failure)).toContain('首次安全失败 · 收据 123：original safe handler failure');
    root.replaceChildren(valetLifecycleControls({ ...task, status: 'running' })); await find(root, '停止管家').onclick();
    expect(ordinary.at(-1)).toEqual({ method: 'worker.cancel', params: { id: 17 } });
  } finally { closeDialog(); ui.inputEditor?.dispose(); navigation(); resetUiState(); dom.restore(); }
});

// Device-wide password submissions have no project/composer equivalent. Keep a
// single representative UI flow here; the service/Provider chain is validated separately.
test('device Valet page keeps per-input password authority, unknown receipts and page ownership separate', async () => {
  const secret = 'ui-device-password-CANARY', submissions = [], requests = [];
  const profile = { agent: 'pi', config_mode: 'lush', connection_id: '00000000-0000-4000-8000-000000000001', model: 'deepseek/deepseek-chat', thinking: '' };
  let accepted = false, unknown = false, found = false, original = null, releaseDetail = null, holdDetail = false;
  const task = { id: 'device-worker-1', worker_number: 'DV1', status: 'ready', revision: 1, model_selection: profile,
    result: 'safe result', result_truncated: true, can_append: true, can_stop: true };
  const receipt = definition => ({ version: 1, found: true, definition, worker: { ...task }, instruction: { id: 'input-1', instruction: definition.instruction, status: 'succeeded' } });
  const fetch = async (url, options = {}) => {
    const path = new URL(url, 'http://fixture.invalid'); requests.push({ path: path.pathname, method: options.method || 'GET' });
    if (path.pathname.endsWith('/options')) return Response.json({ version: 1, default_profile: profile,
      connections: [{ id: profile.connection_id, label: 'Isolated source' }], registered_models: [{ id: 'registered-1', name: 'Named model', connection_id: profile.connection_id, model: profile.model }], truncated: true, coverage: 'bounded_device_valet_options' });
    if (path.pathname.endsWith('/status')) return Response.json({ version: 1, online: true, active: 0 });
    if (path.pathname.endsWith('/list')) return Response.json({ version: 1, online: true, items: submissions.length ? [task] : [], next_cursor: null, has_more: false });
    if (path.pathname.endsWith('/detail')) {
      if (holdDetail) { holdDetail = false; await new Promise(resolve => { releaseDetail = resolve; }); }
      return Response.json({ version: 1, worker: { ...task }, instructions: [{ id: 'input-1', instruction: 'confirmed input', status: 'succeeded' }], events: [], next_cursor: null, has_more: false, history_complete: false });
    }
    if (path.pathname.endsWith('/submit')) {
      const body = JSON.parse(options.body); expect(Object.keys(body).sort()).toEqual(['confirm','definition','password']);
      expect(body.password).toBe(secret); expect(body.confirm).toBe(true); submissions.push(body.definition);
      if (!accepted) return Response.json({ code: 'elevation_password_rejected', execution: 'not_started' }, { status: 403 });
      if (unknown) { original = body.definition; throw Error(secret); }
      return Response.json(receipt(body.definition));
    }
    if (path.pathname.endsWith('/receipt')) return Response.json(found ? receipt(original) : { version: 1, found: false });
    if (path.pathname.endsWith('/stop')) { expect(JSON.parse(options.body)).toEqual({ id: task.id }); task.status = 'stopping'; task.can_stop = false; task.can_append = false; return Response.json({ version: 1, worker: { ...task } }); }
    throw Error('unexpected device UI fixture route');
  };
  const dom = installDom({ fetch }); resetUiState(); dom.location.hash = '#device-valet';
  const page = createDeviceValetPage({ container: dom.node('detail') });
  try {
    await page.ready;
    expect(requests.every(item => item.method === 'GET')).toBe(true);
    expect(page.root.querySelector('.device-valet-model-settings').open).not.toBe(true);
    expect(page.root.querySelector('.device-valet-model-settings').querySelector('.hint').textContent).toContain('候选目录已裁剪');
    expect(page.root.querySelector('.device-valet-create').querySelector('textarea')).toBeTruthy();
    const draft = page.root.querySelector('.device-valet-create').querySelector('textarea');
    const execute = find(page.root, '核对并执行');
    draft.value = '  first exact input\nwith whitespace  '; draft.oninput();
    expect(execute.classList.contains('agent-call')).toBe(true); expect(execute.getAttribute('data-help')).toContain('token');
    let opening = execute.onclick(); await until(() => dialogButton(dom, '验证密码并执行这一条'));
    let password = dom.node('modal').querySelector('.device-valet-password'); password.value = secret;
    expect(dialogText(dom)).toContain(draft.value); expect(dialogText(dom)).toContain(profile.model); expect(dialogText(dom)).toContain('Isolated source');
    draft.value = 'confirmed input'; draft.oninput(); await opening;
    expect(password.value).toBe(''); expect(submissions).toHaveLength(0);
    opening = execute.onclick(); await until(() => dialogButton(dom, '验证密码并执行这一条'));
    password = dom.node('modal').querySelector('.device-valet-password'); password.value = secret;
    await dialogButton(dom, '验证密码并执行这一条').onclick(); expect(dialogText(dom)).toContain('密码验证未通过'); expect(password.value).toBe('');
    accepted = true; password.value = secret; await dialogButton(dom, '验证密码并执行这一条').onclick(); await opening;
    expect(submissions.at(-1)).toMatchObject({ kind: 'create', mode: 'device_valet', scope: 'device_resources', instruction: 'confirmed input', profile });
    expect(draft.value).toBe(''); expect(deepText(page.root)).toContain('safe result');
    expect(page.root.querySelector('.device-valet-result-truncated').textContent).toContain('结果已裁剪');
    expect(page.root.querySelector('.device-valet-audit').open).not.toBe(true);
    expect(page.root.querySelector('.device-valet-model-info').open).not.toBe(true);
    await find(page.root, '追加指令').onclick();
    const append = page.root.querySelector('.device-valet-append').querySelector('textarea'); append.value = 'append unknown'; append.oninput();
    expect(page.root.querySelector('.device-valet-append').querySelector('.device-valet-model-settings').querySelector('.hint').textContent).toContain('不是完整清单');
    unknown = true; opening = find(page.root, '核对追加指令').onclick(); await until(() => dialogButton(dom, '验证密码并执行这一条'));
    password = dom.node('modal').querySelector('.device-valet-password'); expect(password.value).toBe(''); password.value = secret;
    await dialogButton(dom, '验证密码并执行这一条').onclick(); expect(password.value).toBe('');
    expect(dialogText(dom)).not.toContain(secret); expect(dialogButton(dom, '验证密码并执行这一条').disabled).toBe(true);
    closeDialog(); await opening;
    const count = submissions.length; expect(find(page.root, '核对追加指令').disabled).toBe(true);
    await find(page.root, '只读核对原提交').onclick(); expect(deepText(page.root)).toContain('保留未知'); expect(submissions).toHaveLength(count);
    found = true; unknown = false; await find(page.root, '只读核对原提交').onclick(); await until(() => find(page.root, '追加指令'));
    expect(submissions).toHaveLength(count); expect(storageText(dom.sessionStorage) + storageText(dom.localStorage)).not.toContain(secret);
    await find(page.root, '停止设备管家').onclick(); expect(deepText(page.root)).toContain('尚未确认退出');
    expect(requests.filter(row => row.path.endsWith('/stop'))).toHaveLength(1);
    task.can_append = true; task.status = 'ready'; await page.refresh(); await find(page.root, '追加指令').onclick();
    const next = page.root.querySelector('.device-valet-append').querySelector('textarea'); next.value = 'fresh independent input'; next.oninput();
    opening = find(page.root, '核对追加指令').onclick(); await until(() => dialogButton(dom, '验证密码并执行这一条'));
    password = dom.node('modal').querySelector('.device-valet-password'); expect(password.value).toBe(''); password.value = secret;
    holdDetail = true; const delayed = page.refresh(); await until(() => releaseDetail);
    page.dispose(); await opening; expect(password.value).toBe('');
    const replacement = dom.node('detail'); replacement.textContent = 'replacement page'; replacement.replaceChildren();
    releaseDetail(); await delayed; expect(replacement.textContent).toBe('replacement page');
    expect(submissions).toHaveLength(count); expect(requests.some(row => row.path.startsWith('/p/'))).toBe(false);
  } finally { page.dispose(); closeDialog(); resetUiState(); dom.restore(); }
});
