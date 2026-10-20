import { test, expect } from 'bun:test';
import { installDom, dialogButton, dialogText, deepText } from '../dom-stub.js';
import { until } from '../helpers.js';
import { initComposer } from '../../src/ui/web/assets/composer.js';
import { valetLifecycleControls } from '../../src/ui/web/assets/valet-actions.js';
import { renderManagementState, renderManagementFailure } from '../../src/ui/web/assets/management-state.js';
import { closeDialog } from '../../src/ui/web/assets/dialog.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';

const find = (root, title) => root.querySelectorAll('button').find(node => node.textContent === title);
const choice = root => root.querySelector('.project-elevation-label').querySelector('input');
const storageText = storage => Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index))).join('\n');

// Replaces the retired global-ADM main flow. This UI-only injected HTTP contract does not
// claim real Host password verification or elevated native execution; W363 integrates those.
test('project Valet input: ordinary default, one-input password elevation, unknown receipt and next-input ordinary', async () => {
  const passwordCanary = 'isolated-test-password-7A', ordinary = [], elevated = [];
  let passwordAccepted = false, receiptFound = false, lastUnknown = null;
  const task = { id: 17, worker_number: 'V9', role: 'manager', task_kind: 'management', status: 'completed',
    management: { version: 1, can_append: true, state: 'idle', enabled: false, origin: 'input', authority: { mode: 'administrator', scope: 'current_project' } } };
  const dom = installDom({ fetch: async (url, options = {}) => {
    const path = new URL(url, 'http://fixture.invalid').pathname;
    if (path.endsWith('/api/input-parents')) return Response.json({ items: [], next_cursor: null, has_more: false });
    if (path.endsWith('/api/action')) {
      const body = JSON.parse(options.body); ordinary.push(body);
      return Response.json(body.method === 'management.submit' ? { management: true, task } : task);
    }
    if (path.endsWith('/api/management/elevate')) {
      const body = JSON.parse(options.body);
      expect(Object.keys(body).sort()).toEqual(['confirm', 'definition', 'password']); expect(body.confirm).toBe(true);
      expect(body.password).toBe(passwordCanary); elevated.push(structuredClone(body.definition));
      if (!passwordAccepted) return Response.json({ error: 'authentication rejected', code: 'elevation_password_rejected', execution: 'not_started' }, { status: 403 });
      if (body.definition.instruction === 'append unknown') { lastUnknown = structuredClone(body.definition); throw new Error(passwordCanary); }
      return Response.json({ management: true, task, instruction: body.definition.instruction });
    }
    if (path.endsWith('/api/management/elevation-receipt')) return Response.json(receiptFound
      ? { version: 1, found: true, definition: lastUnknown, task, instruction: lastUnknown.instruction }
      : { version: 1, found: false });
    throw new Error('unexpected isolated UI route: ' + path);
  } });
  resetUiState(); ui.view = { id: 'overview' }; ui.lastSnapshot = { status: { project: '/isolated/elevation-project' } }; dom.location.pathname = '/p/1234567890abcdef/';
  const navigation = registerNavigation({ refresh: async () => {} });
  try {
    await initComposer(); await dom.node('composer-menu-management').onclick();
    const shell = dom.node('composer-shell'), input = dom.node('input');
    expect(choice(shell).checked).toBe(false);
    input.value = 'ordinary first'; input.oninput(); await dom.node('input-form').onsubmit({ preventDefault() {} });
    expect(ordinary).toHaveLength(1); expect(ordinary[0].method).toBe('management.submit'); expect(elevated).toHaveLength(0);
    input.value = '  first elevated\n exact whitespace  '; input.oninput(); choice(shell).checked = true; choice(shell).onchange();
    expect(deepText(shell)).toContain('不管理其他项目');
    let opening = dom.node('input-form').onsubmit({ preventDefault() {} });
    await until(() => dialogButton(dom, '验证密码并执行这一条'));
    let secret = dom.node('modal').querySelector('.project-elevation-password');
    expect(secret.type).toBe('password'); expect(secret.getAttribute('autocomplete')).toBe('current-password');
    secret.value = passwordCanary;
    input.value = '  amended first\n exact whitespace  '; input.oninput(); await opening;
    expect(secret.value).toBe(''); expect(elevated).toHaveLength(0); expect(dom.node('modal').hidden).toBe(true);
    opening = dom.node('input-form').onsubmit({ preventDefault() {} }); await until(() => dialogButton(dom, '验证密码并执行这一条'));
    expect(dialogText(dom)).toContain('创建管家并执行以下首条指令'); expect(dialogText(dom)).toContain('current_project');
    expect(dialogText(dom)).toContain('目标项目：/isolated/elevation-project');
    expect(dialogText(dom)).toContain('  amended first\n exact whitespace  ');
    secret = dom.node('modal').querySelector('.project-elevation-password'); secret.value = passwordCanary;
    await dialogButton(dom, '验证密码并执行这一条').onclick();
    expect(secret.value).toBe(''); expect(dialogText(dom)).toContain('密码验证未通过'); expect(elevated).toHaveLength(1);
    passwordAccepted = true; secret.value = passwordCanary;
    expect(dialogButton(dom, '验证密码并执行这一条').classList.contains('agent-call')).toBe(true);
    await dialogButton(dom, '验证密码并执行这一条').onclick(); await opening;
    expect(elevated[1]).toMatchObject({ kind: 'submit', mode: 'administrator', scope: 'current_project', instruction: '  amended first\n exact whitespace  ' });
    expect(choice(shell).checked).toBe(false); expect(ui.composerElevated).toBe(false); expect(input.value).toBe('');
    expect(storageText(dom.localStorage) + storageText(dom.sessionStorage)).not.toContain(passwordCanary);

    ui.view = { id: 'task', key: 'task:17' }; ui.selected = task.id;
    const root = dom.node('detail'); root.replaceChildren(valetLifecycleControls(task));
    let appending = find(root, '追加输入').onclick();
    let body = dom.node('modal').querySelector('textarea'); body.value = 'ordinary append'; body.oninput();
    expect(choice(dom.node('modal')).checked).toBe(false);
    await dialogButton(dom, '提交追加').onclick(); await appending;
    expect(ordinary.at(-1)).toEqual({ method: 'worker.message', params: { id: 17, body: 'ordinary append' } });
    appending = find(root, '追加输入').onclick(); body = dom.node('modal').querySelector('textarea'); body.value = 'append unknown'; body.oninput();
    const toggle = choice(dom.node('modal')); toggle.checked = true; toggle.onchange();
    expect(dialogText(dom)).toContain('V9 · ID 17');
    secret = dom.node('modal').querySelector('.project-elevation-password'); secret.value = passwordCanary;
    await dialogButton(dom, '验证密码并执行这一条').onclick();
    expect(secret.value).toBe(''); expect(dialogText(dom)).not.toContain(passwordCanary);
    expect(dialogButton(dom, '验证密码并执行这一条').disabled).toBe(true);
    const count = elevated.length;
    await find(dom.node('modal'), '只读核对提权提交').onclick();
    expect(dialogText(dom)).toContain('继续保留未知'); expect(elevated).toHaveLength(count);
    expect(storageText(dom.sessionStorage)).toContain(lastUnknown.client_request_id);
    expect(storageText(dom.sessionStorage)).not.toContain(passwordCanary);
    receiptFound = true; await find(dom.node('modal'), '只读核对提权提交').onclick();
    expect(dialogText(dom)).toContain('不代表执行成功'); expect(elevated).toHaveLength(count);
    closeDialog(); await appending;
    appending = find(root, '追加输入').onclick(); expect(choice(dom.node('modal')).checked).toBe(false); closeDialog(); await appending;
    const state = renderManagementState(task); expect(deepText(state)).toContain('管理员 · 仅当前项目／本条');
    expect(state.querySelector('.management-audit-details').open).not.toBe(true);
    const nextRound = renderManagementState({ ...task, management: { ...task.management,
      authority: { mode: 'ordinary', scope: 'current_project' }, last_execution: { authority: task.management.authority } } });
    expect(nextRound.querySelector('.management-authority').textContent).toContain('普通管家');
    expect(deepText(nextRound)).toContain('最近事项权限：管理员');
    const failure = renderManagementFailure({ ...task, error: 'generic failure', management: { ...task.management, state: 'unknown',
      first_failure: { receipt_id: 123, detail: 'original safe handler failure' } } });
    expect(deepText(failure)).toContain('首次安全失败 · 收据 123：original safe handler failure');
    root.replaceChildren(valetLifecycleControls({ ...task, status: 'running' }));
    await find(root, '停止管家').onclick();
    expect(ordinary.at(-1)).toEqual({ method: 'worker.cancel', params: { id: 17 } });
    expect(dom.node('modal').hidden).toBe(true); // high-permission emergency stop adds no operation confirmation
  } finally { closeDialog(); navigation(); resetUiState(); dom.restore(); }
});
