import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { until } from '../helpers.js';

const json = value => ({ ok: true, json: async () => structuredClone(value) });
const levels = ['off', 'merge', 'accept', 'archive'];
const catalogue = { version: 1, revision: 'catalogue-v1', templates: [], triggers: [
  { id: 'worker.delivery_ready', label: '交付就绪', description: '实际退出且成果准备好。' },
  { id: 'delivery.integrated', label: '交付落地', description: '成果已集成，不绕过验收门。' },
  { id: 'worker.accepted', label: '已验收', description: '明确验收后才清理现场。' },
], actions: [
  { type: 'request_merge', label: '申请合并', description: '父队列申请。', triggers: ['worker.delivery_ready'], modes: ['once', 'persistent'], agent_call: true },
  { type: 'notify', label: '告知', description: '纯告知。', triggers: [], modes: ['once', 'persistent'], agent_call: false },
  { type: 'accept_worker', label: '自动验收', description: '安全校验，不是业务评审。', triggers: ['delivery.integrated'], modes: ['persistent'], builtin_only: true, agent_call: false },
  { type: 'archive_worker', label: '自动归档', description: '保留历史，不丢弃未提交改动。', triggers: ['worker.accepted'], modes: ['persistent'], builtin_only: true, agent_call: false },
] };
function taskFor(level = 'off', options = {}) {
  const completion = { level, min_level: 'off', locked: false, editable: true, reason: null, phase: 'merge', state: 'waiting', last_execution: null, ...options.completion };
  const task = { id: 20, worker_number: 'W5', task_kind: 'order', status: 'waiting', branch: 'feature', goal: '目标', integration: 'none',
    auto_merge: { enabled: level !== 'off', locked: false, editable: true }, deps: [], dependents: [], children: [], messages: [], notices: [], ...options,
    completion, hooks: { version: 1, worker_id: 20, revision: 'mount-v1', completion, mounts: [
      { id: 'auto-merge', name: '自动合并', trigger: 'worker.delivery_ready', actions: [{ type: 'request_merge' }] },
      { id: 'auto-accept', name: '自动验收', trigger: 'delivery.integrated', actions: [{ type: 'accept_worker' }] },
      { id: 'auto-archive', name: '自动归档', trigger: 'worker.accepted', actions: [{ type: 'archive_worker' }] },
    ].map((mount, index) => ({ ...mount, builtin: true, mode: 'persistent', enabled: levels.indexOf(level) > index, editable: false, removable: false, state: 'waiting' })) } };
  return task;
}
let intercept, actions, responseTask;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null;
  if (body) actions.push(body);
  const custom = intercept?.(path, body); if (custom) return custom;
  if (path.endsWith('/api/hooks')) return json(catalogue);
  if (body?.method === 'worker.completion') return json({ ...responseTask.hooks, revision: 'mount-v2', completion: { ...responseTask.completion, level: body.params.level } });
  if (body?.method === 'worker.auto_merge') return json({ auto_merge: { ...responseTask.auto_merge, enabled: body.params.enabled } });
  throw new Error(`unexpected request ${path}`);
} });
const { autoCompletionControl } = await import('../../src/ui/web/assets/hook-controls.js');
const { workerHooks, openHooks } = await import('../../src/ui/web/assets/render-hooks.js');
const { createHookForm } = await import('../../src/ui/web/assets/hook-form.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const root = () => dom.node('detail');
const btn = node => node.querySelectorAll('button').find(button => button.textContent === '保存自动级别');
function selectLevel(node, level) { const select = node.querySelector('.hook-completion-select'); select.value = level; select.onchange(); return select; }
function control(task = responseTask, refresh = () => {}, owns = () => true) {
  const node = autoCompletionControl(task, task.hooks, refresh, owns); root().replaceChildren(node); return node;
}
beforeEach(() => {
  closeDialog(); actions = []; intercept = null; responseTask = taskFor(); ui.hooksPage = null; dom.location.pathname = '/';
  activateDetailView({ view: 'task', key: 'task-20' }); ui.hookCatalogue = catalogue;
});
afterAll(() => { closeDialog(); dom.restore(); });

test('four highest levels show one control and three ordered read-only built-ins without contradictory switches', () => {
  for (const level of levels) {
    const section = workerHooks(taskFor(level), { refresh() {} }); root().replaceChildren(section);
    expect(section.querySelectorAll('.hook-completion-select')).toHaveLength(1);
    expect(section.querySelector('.hook-completion-select').value).toBe(level);
    expect(section.querySelectorAll('input')).toHaveLength(0);
    expect(section.querySelectorAll('.hook-mount').map(row => row.dataset.hookId)).toEqual(['auto-merge', 'auto-accept', 'auto-archive']);
    expect(section.querySelectorAll('.hook-mount').filter(row => deepText(row).includes('启用'))).toHaveLength(levels.indexOf(level));
    expect(section.querySelectorAll('button').some(button => ['启用 Hook', '停用 Hook', '移除挂载'].includes(button.textContent))).toBe(false);
    expect(deepText(section)).toContain('第 2 步'); expect(deepText(section)).toContain('第 3 步');
    expect(deepText(section)).toContain('不保证业务质量'); expect(deepText(section)).toContain('不丢弃未提交改动');
    expect(deepText(section)).toContain('只提醒下一人工环节'); expect(actions).toHaveLength(0);
  }
});

test('selection is only a draft; explicit save authorizes exactly one Worker using its revision and integer identity', async () => {
  let refreshed = 0;
  const node = control(responseTask, () => { refreshed++; });
  expect(btn(node).disabled).toBe(true);
  const select = selectLevel(node, 'accept'); expect(actions).toHaveLength(0);
  expect(deepText(node)).toContain('已保存：关闭自动链');
  expect(btn(node).classList.contains('agent-call')).toBe(true);
  expect(btn(node).getAttribute('data-help')).toContain('token');
  await btn(node).onclick();
  expect(actions).toEqual([{ method: 'worker.completion', params: { id: 20, level: 'accept', expected_revision: 'mount-v1' } }]);
  expect(select.value).toBe('accept'); expect(btn(node).disabled).toBe(true); expect(refreshed).toBe(1);
  selectLevel(node, 'merge'); await btn(node).onclick();
  expect(actions.at(-1).params.expected_revision).toBe('mount-v2');
});

test('child minimum merge is not a blanket lock: off is disabled but explicit higher user authorization works', async () => {
  responseTask = taskFor('merge', { task_kind: 'child', auto_merge: { enabled: true, locked: true, editable: false },
    completion: { min_level: 'merge', locked: true } });
  const node = control(); const select = node.querySelector('select');
  expect(select.disabled).toBe(false);
  expect(select.children.find(option => option.value === 'off').disabled).toBe(true);
  selectLevel(node, 'off'); expect(select.value).toBe('merge');
  selectLevel(node, 'accept'); await btn(node).onclick();
  expect(actions[0].params.level).toBe('accept'); expect(deepText(node)).toContain('设置不继承');
});

test('already merged and accepted Workers can raise the level without using old toggle gates or claiming model review', async () => {
  for (const status of ['awaiting_acceptance', 'completed']) {
    responseTask = taskFor('merge', { status, integration: 'merged', merge_readiness: { ready: true },
      auto_merge: { enabled: true, editable: false }, completion: { phase: status === 'completed' ? 'archive' : 'accept' } });
    const node = control(); const select = selectLevel(node, 'accept');
    expect(select.disabled).toBe(false); expect(btn(node).classList.contains('agent-call')).toBe(false);
    expect(btn(node).getAttribute('data-help')).not.toContain('消耗 token');
    expect(select.children.find(option => option.value === 'off').disabled).toBe(true);
    await btn(node).onclick(); expect(actions.at(-1).method).toBe('worker.completion');
    expect(deepText(node)).toContain('不重新合并已落地成果');
  }
});

test('archive authorization uses an application dialog and names subtree removal, preserved history and no discard', async () => {
  const node = control(); selectLevel(node, 'archive');
  const saving = btn(node).onclick();
  expect(actions).toHaveLength(0); expect(dom.node('modal').hidden).toBe(false);
  expect(deepText(dom.node('modal'))).toContain('分支及后代的 worktree/ref');
  expect(deepText(dom.node('modal'))).toContain('不丢弃未提交改动');
  expect(dialogButton(dom, '授权自动归档').classList.contains('agent-call')).toBe(true);
  await dialogButton(dom, '授权自动归档').onclick(); await saving;
  expect(actions.at(-1).params.level).toBe('archive');
  expect(btn(node).disabled).toBe(true);
});

test('leaving the Worker while archive confirmation is open prevents any authorization after confirming', async () => {
  let refreshed = 0;
  const section = workerHooks(responseTask, { refresh() { refreshed++; } }); root().replaceChildren(section);
  selectLevel(section, 'archive'); const saving = btn(section).onclick();
  activateDetailView({ view: 'overview' }); root().replaceChildren(document.createElement('article'));
  await dialogButton(dom, '授权自动归档').onclick(); await saving;
  expect(actions).toHaveLength(0); expect(refreshed).toBe(0); expect(root().querySelector('select')).toBeNull();
});

test('project or environment changes during the archive dialog block saving even if the page identity has not changed yet', async () => {
  for (const next of ['/p/2222222222222222/', '/e/remote/p/1111111111111111/', '/p/invalid/']) {
    dom.location.pathname = '/p/1111111111111111/';
    const identity = ui.view;
    const section = workerHooks(responseTask, { refresh() {} }); root().replaceChildren(section);
    selectLevel(section, 'archive'); const saving = btn(section).onclick();
    dom.location.pathname = next; expect(ui.view).toBe(identity);
    await dialogButton(dom, '授权自动归档').onclick(); await saving;
    expect(actions).toHaveLength(0); expect(section.querySelector('select').disabled).toBe(true);
  }
});

test('a save response from the previous project cannot toast or refresh the newly selected project', async () => {
  let resolve, refreshed = 0;
  dom.location.pathname = '/p/1111111111111111/';
  const identity = ui.view;
  intercept = (_path, body) => body?.method === 'worker.completion' ? new Promise(done => { resolve = done; }) : null;
  const node = control(responseTask, () => { refreshed++; }); selectLevel(node, 'merge');
  const saving = btn(node).onclick(); await until(() => resolve);
  dom.location.pathname = '/p/2222222222222222/'; expect(ui.view).toBe(identity);
  dom.node('message').textContent = 'new project';
  resolve(json({ ...responseTask.hooks, completion: { ...responseTask.completion, level: 'merge' } })); await saving;
  expect(actions).toHaveLength(1); expect(refreshed).toBe(0); expect(dom.node('message').textContent).toBe('new project');
  expect(node.querySelector('select').disabled).toBe(true);
});

test('an in-flight save does not lock a same-numbered Worker in a different project', async () => {
  let resolve;
  dom.location.pathname = '/p/1111111111111111/';
  intercept = (_path, body) => body?.method === 'worker.completion' ? new Promise(done => { resolve = done; }) : null;
  const previous = control(); selectLevel(previous, 'merge');
  const saving = btn(previous).onclick(); await until(() => resolve);
  dom.location.pathname = '/p/2222222222222222/';
  const current = control(); selectLevel(current, 'accept');
  expect(current.querySelector('select').disabled).toBe(false); expect(btn(current).disabled).toBe(false);
  resolve(json({ ...responseTask.hooks, completion: { ...responseTask.completion, level: 'merge' } })); await saving;
  expect(actions).toHaveLength(1);
});

test('cancelled archive authorization keeps the draft without changing or reporting saved authorization', async () => {
  const node = control(); selectLevel(node, 'archive');
  const saving = btn(node).onclick(); await dialogButton(dom, '取消').onclick(); await saving;
  expect(actions).toHaveLength(0); expect(btn(node).disabled).toBe(false);
  expect(deepText(node)).toContain('已保存：关闭自动链');
});

test('freeze, in-flight action, unknown, terminal failure, archived branch and missing revision cannot be bypassed', async () => {
  const options = [
    { reservation: { status: 'requested' } }, { reservation: { status: 'suspended' } },
    { completion: { state: 'running' } }, { completion: { state: 'unknown', last_execution: { error: '检查现场 <script>secret</script>' } } },
    { completion: { editable: false, reason: '当前安全门关闭' } }, { status: 'failed' }, { status: 'cancelled' }, { archived: true },
  ];
  for (const option of options) {
    const node = control(taskFor('merge', option));
    expect(node.querySelector('select').disabled).toBe(true); expect(btn(node).disabled).toBe(true);
    expect(node.querySelector('.hook-completion-help').tabIndex).toBe(0);
    selectLevel(node, 'accept'); await btn(node).onclick(); expect(actions).toHaveLength(0);
    expect(node.querySelector('script')).toBeNull();
  }
  const missing = taskFor(); delete missing.hooks.revision;
  expect(control(missing).querySelector('select').disabled).toBe(true);
});

test('failed or stale saves restore the actual saved level and surface safe diagnostics instead of assuming success', async () => {
  intercept = (_path, body) => body?.method === 'worker.completion' ? { ok: false, json: async () => ({ error: 'revision conflict' }) } : null;
  const node = control(taskFor('merge', { completion: { state: 'failed', phase: 'accept', last_execution: { error: '<script>dirty</script>' } } }));
  expect(deepText(node)).toContain('<script>dirty</script>'); expect(node.querySelector('script')).toBeNull();
  selectLevel(node, 'accept'); await btn(node).onclick();
  expect(node.querySelector('select').value).toBe('merge'); expect(btn(node).disabled).toBe(true);
  expect(dom.node('error').textContent).toContain('revision conflict'); expect(actions).toHaveLength(1);
});

test('pending save blocks duplicate requests and late completion cannot toast or refresh another page', async () => {
  let resolve, owned = true, refreshed = 0;
  intercept = (_path, body) => body?.method === 'worker.completion' ? new Promise(done => { resolve = done; }) : null;
  const node = control(responseTask, () => { refreshed++; }, () => owned); selectLevel(node, 'merge');
  const saving = btn(node).onclick(); await until(() => resolve);
  expect(node.querySelector('select').disabled).toBe(true);
  await btn(node).onclick(); expect(actions).toHaveLength(1);
  owned = false; activateDetailView({ view: 'overview' }); root().replaceChildren(document.createElement('article'));
  dom.node('message').textContent = 'new page';
  resolve(json({ ...responseTask.hooks, completion: { ...responseTask.completion, level: 'merge' } })); await saving;
  expect(refreshed).toBe(0); expect(dom.node('message').textContent).toBe('new page'); expect(root().querySelector('select')).toBeNull();
});

test('malformed save projections never claim a level was saved or enable repeated mutation with old revisions', async () => {
  intercept = (_path, body) => body?.method === 'worker.completion' ? json({ worker_id: 999, revision: 'mount-v2', completion: { level: 'archive' } }) : null;
  const node = control(); selectLevel(node, 'accept'); await btn(node).onclick();
  expect(node.querySelector('select').disabled).toBe(true); expect(btn(node).disabled).toBe(true);
  expect(dom.node('error').textContent).toContain('勿重复提交');
});

test('old services without completion retain only the original auto-merge control, including null capability', async () => {
  for (const explicitNull of [false, true]) {
    const old = taskFor(); delete old.completion; delete old.hooks.completion;
    if (explicitNull) old.hooks.completion = null;
    old.hooks.mounts = [old.hooks.mounts[0]];
    const section = workerHooks(old, { refresh() {} }); root().replaceChildren(section);
    expect(section.querySelector('.hook-completion-select')).toBeNull();
    const input = section.querySelector('input'); input.checked = true; await input.onchange();
    expect(actions.at(-1)).toEqual({ method: 'worker.auto_merge', params: { id: 20, enabled: true } });
  }
});

test('legacy fallback also rejects mutation if the project changes before its page identity updates', async () => {
  dom.location.pathname = '/p/1111111111111111/';
  const old = taskFor(); delete old.completion; delete old.hooks.completion; old.hooks.mounts = [old.hooks.mounts[0]];
  const section = workerHooks(old, { refresh() {} }); root().replaceChildren(section);
  const input = section.querySelector('input');
  dom.location.pathname = '/p/2222222222222222/'; input.checked = true; await input.onchange();
  expect(actions).toHaveLength(0); expect(input.checked).toBe(false);
});

test('builtin-only actions are explained in the project directory but excluded and rejected by the custom editor', async () => {
  await openHooks(); expect(deepText(root())).toContain('仅内置自动链 · 不可自定义安装');
  const form = createHookForm(catalogue, { initial: { name: '规则', trigger: 'delivery.integrated' } });
  const type = form.node.querySelector('[aria-label="动作类型"]');
  expect(type.children.map(option => option.value)).toEqual(['notify']);
  type.value = 'accept_worker'; expect(form.validate()).toContain('不支持所选动作');
  const trigger = form.node.querySelector('[aria-label="触发节点"]'); trigger.value = 'worker.accepted'; trigger.onchange();
  expect(type.children.map(option => option.value)).not.toContain('archive_worker');
});

test('compact graph entry shares the configured highest level without adding mutation or Agent buttons', () => {
  const compact = workerHooks(taskFor('accept'), { compact: true });
  expect(deepText(compact)).toContain('自动链：自动到验收');
  expect(compact.querySelector('select')).toBeNull(); expect(compact.querySelector('input')).toBeNull();
  expect(compact.querySelector('button').classList.contains('agent-call')).toBe(false);
});

test('detail polling preserves a staged completion choice until it is saved or reverted', async () => {
  const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
  renderDetail(responseTask, null, null, null);
  const section = root().querySelector('.worker-hooks'); selectLevel(section, 'accept');
  expect(section.dataset.completionEditing).toBe('true');
  renderDetail({ ...responseTask, hooks: { ...responseTask.hooks, revision: 'mount-v2' } }, null, null, null);
  expect(root().querySelector('.worker-hooks')).toBe(section);
  expect(section.querySelector('select').value).toBe('accept');
  selectLevel(section, 'off'); expect(section.dataset.completionEditing).toBe('false');
  renderDetail(responseTask, null, null, null);
  expect(root().querySelector('.worker-hooks')).not.toBe(section);
});
