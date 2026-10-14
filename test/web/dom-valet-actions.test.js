import { test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { installDom, answerDialog, dialogText, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld(), valet = { id: 801, worker_number: 'V12', role: 'manager', task_kind: 'management',
  goal: '查询状态', status: 'waiting', calls: 0, children: [],
  management: { version: 1, revision: 'binding-r1', enabled: true, state: 'waiting_actions', mode: 'once' } };
let requests = [], navigation = [], failure = null, deleteBlocked = false, mutationGate = null;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = new URL(String(url), 'http://local').pathname.replace(/^\/p\/[a-f0-9]{16}/, '');
  if (path === '/api/worker/801/delete-preview') {
    requests.push({ method: 'preview' });
    return json({ id: 801, revision: 'preview-r1', can_delete: !deleteBlocked,
      blockers: deleteBlocked ? ['V12: management authorization is enabled'] : [], warnings: [],
      workers: [{ id: 801, worker_number: 'V12', goal: valet.goal, status: 'waiting' }], inputs: [],
      resources: { worktrees: [], branches: [], files: ['/tmp/example/.lush/management/801'] } });
  }
  if (path === '/api/action' && options.body) {
    const request = JSON.parse(options.body); requests.push(request);
    if (mutationGate) await mutationGate;
    return failure === 'mutation' ? json({ error: 'unknown connection result' }, 409) : json(valet);
  }
  return world.fetchImpl(url, options);
} });
const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
const { valetLifecycleControls } = await import('../../src/ui/web/assets/valet-actions.js');
const { workerDeleteControl } = await import('../../src/ui/web/assets/worker-delete.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const { activateDetailView, openResource } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { ui, resetUiState } = await import('../../src/ui/web/assets/state.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const btn = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
let restoreNavigation;
function view(task = valet) {
  activateDetailView({ view: 'task', key: 'task-801', hash: '#worker-801' });
  ui.selected = 801; ui.detailTask = 801; renderDetail(task, { events: [] }, null, null);
  return dom.node('detail');
}
beforeEach(() => {
  closeDialog(); resetUiState(); dom.location.pathname = '/p/1234567890abcdef';
  requests = []; navigation = []; failure = null; deleteBlocked = false; mutationGate = null;
  restoreNavigation = registerNavigation({
    detail: async id => { navigation.push(['detail', id]); },
    refresh: async () => { navigation.push(['refresh']); },
    resource: id => { navigation.push(['resource', id]); return openResource(id); },
  });
});
afterEach(() => { closeDialog(); restoreNavigation(); });
afterAll(() => dom.restore());

test('Valet detail offers only non-Agent lifecycle actions, not development or Git actions', () => {
  const panel = view();
  for (const label of ['停用授权', '停止管家', '删除']) {
    const control = btn(panel, label); expect(control).toBeTruthy();
    expect(control.classList.contains('agent-call')).toBe(false); expect(control.getAttribute('data-help')).toBeTruthy();
  }
  for (const label of ['追加输入', '调整运行设置', '检查后重试', '合并', '验收']) expect(btn(panel, label)).toBeUndefined();
  expect(panel.querySelector('.worker-hooks')).toBeNull(); expect(panel.querySelector('.worker-relations')).toBeNull();
  expect(requests).toEqual([]);
  expect(valetLifecycleControls({ ...valet, role: 'agent', task_kind: 'child' })).toBeNull();
});

test('disable confirmation submits the fixed binding revision once without a model call', async () => {
  const panel = view(), control = btn(panel, '停用授权');
  const pending = control.onclick(); await flush();
  expect(dialogText(dom)).toContain('不会强杀'); expect(requests).toEqual([]);
  await control.onclick(); await answerDialog(dom, '停用授权'); await pending;
  expect(requests).toEqual([{ method: 'management.binding_update', params: { id: 801, enabled: false, expected_revision: 'binding-r1' } }]);
  expect(navigation).toEqual([['detail', 801]]); expect(control.disabled).toBe(true);
});

test('stop explicitly warns that cancelled does not prove actual invocation exit', async () => {
  const control = btn(view(), '停止管家'), pending = control.onclick(); await flush();
  expect(dialogText(dom)).toContain('cancelled'); expect(dialogText(dom)).toContain('重新预检');
  expect(btn(dom.node('modal'), '停止管家').classList.contains('agent-call')).toBe(false);
  await answerDialog(dom, '停止管家'); await pending;
  expect(requests).toEqual([{ method: 'worker.cancel', params: { id: 801 } }]);
  expect(dom.node('error').textContent).toContain('不代表已完全退出');
  const deletion = workerDeleteControl({ ...valet, status: 'cancelled', agent: { active: true } });
  expect(btn(deletion, '删除').disabled).toBe(true); expect(deletion.getAttribute('data-help')).toContain('真实退出');
});

test('cancelled confirmation and leaving the source project before confirmation never mutate', async () => {
  for (const leave of [false, true]) {
    const control = btn(view(), '停用授权'), pending = control.onclick(); await flush();
    if (leave) dom.location.pathname = '/p/abcdef1234567890';
    await answerDialog(dom, leave ? '停用授权' : '保留'); await pending;
    expect(requests).toEqual([]); expect(control.disabled).toBe(false);
  }
});

test('unknown mutation result retains the view and requires a fresh read, never automatic replay', async () => {
  failure = 'mutation'; const panel = view(), control = btn(panel, '停用授权');
  const pending = control.onclick(); await flush(); await answerDialog(dom, '停用授权'); await pending;
  expect(dom.node('detail')).toBe(panel); expect(navigation).toEqual([]);
  expect(dom.node('error').textContent).toContain('不自动重发'); expect(control.disabled).toBe(true);
  await control.onclick(); await btn(panel, '停止管家').onclick(); expect(requests).toHaveLength(1);
});

test('a successful stop with refresh failure is not reported as a failed or retryable stop', async () => {
  const root = valetLifecycleControls(valet, { refresh: async () => { throw Error('offline'); } });
  const control = btn(root, '停止管家'), pending = control.onclick(); await flush();
  await answerDialog(dom, '停止管家'); await pending;
  expect(requests).toHaveLength(1); expect(dom.node('error').textContent).toContain('操作已提交，刷新失败');
  expect(control.disabled).toBe(true);
});

test('late mutation response does not reopen a Valet detail or overwrite a new project', async () => {
  let release; mutationGate = new Promise(resolve => { release = resolve; });
  const control = btn(view(), '停止管家'), pending = control.onclick(); await flush();
  await answerDialog(dom, '停止管家'); await flush();
  dom.location.pathname = '/p/abcdef1234567890'; activateDetailView({ view: 'overview' });
  dom.node('error').textContent = 'new project'; release(); await pending;
  expect(navigation).toEqual([]); expect(dom.node('error').textContent).toBe('new project');
});

test('Valet deletion relies on fresh backend preflight for enabled/unsettled waiting records', async () => {
  deleteBlocked = true; const control = btn(view(), '删除');
  expect(control.disabled).toBe(false); await control.onclick();
  expect(requests).toEqual([{ method: 'preview' }]); expect(dom.node('modal').hidden).toBe(true);
  expect(dom.node('error').textContent).toContain('authorization is enabled');
});

test('disabled waiting Valet can preflight deletion and returns to Valet list, preserving unrelated development work', async () => {
  const task = { ...valet, management: { ...valet.management, enabled: false } }, panel = view(task);
  const dev = { id: 70, worker_number: 'W20', task_kind: 'order', role: 'agent', status: 'queued' };
  ui.lastSnapshot = { tasks: [task, dev], notices: [], status: {} };
  const control = btn(panel, '删除'), pending = control.onclick(); await flush();
  const text = dialogText(dom);
  expect(text).toContain('彻底删除管家 V12'); expect(text).toContain('非 Git 目录');
  expect(text).toContain('不删除其操作创建的开发 Worker 或时间信号'); expect(text).toContain('management/801');
  await answerDialog(dom, '彻底删除'); await pending;
  expect(requests).toEqual([{ method: 'preview' }, { method: 'worker.delete', params: { id: 801, revision: 'preview-r1', confirm: true } }]);
  expect(navigation).toEqual([['resource', 'valets'], ['refresh']]); expect(ui.view.id).toBe('valets');
  expect(ui.deletedWorkerIds.has(801)).toBe(true); expect(ui.deletedWorkerIds.has(70)).toBe(false);
  expect(ui.lastSnapshot.tasks).toEqual([dev]); expect(deepText(panel)).not.toContain('诊断 W20');
});
