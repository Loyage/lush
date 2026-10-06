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
  return { id: 20, worker_number: 'W5', task_kind: 'order', status: 'waiting', branch: 'feature', goal: '目标', integration: 'none',
    auto_merge: { enabled: level !== 'off', locked: false, editable: true }, deps: [], dependents: [], children: [], messages: [], notices: [], ...options,
    completion, hooks: { version: 1, worker_id: 20, revision: 'mount-v1', completion, mounts: [
      { id: 'auto-merge', name: '自动合并', trigger: 'worker.delivery_ready', actions: [{ type: 'request_merge' }] },
      { id: 'auto-accept', name: '自动验收', trigger: 'delivery.integrated', actions: [{ type: 'accept_worker' }] },
      { id: 'auto-archive', name: '自动归档', trigger: 'worker.accepted', actions: [{ type: 'archive_worker' }] },
    ].map((mount, index) => ({ ...mount, builtin: true, mode: 'persistent', enabled: levels.indexOf(level) > index, editable: false, removable: false, state: 'waiting' })) } };
}
let intercept, actions, reads, responseTask;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null;
  if (body) actions.push(body); else reads.push(path);
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
const choice = (node, level) => node.querySelector(`[data-level="${level}"]`);
const click = (node, level) => choice(node, level).onclick();
const selected = node => node.querySelectorAll('.hook-completion-level').filter(button => button.getAttribute('aria-pressed') === 'true').map(button => button.dataset.level);
function control(task = responseTask, refresh = () => {}, owns = () => true) {
  const node = autoCompletionControl(task, task.hooks, refresh, owns); root().replaceChildren(node); return node;
}
beforeEach(() => {
  closeDialog(); actions = []; reads = []; intercept = null; responseTask = taskFor(); ui.hooksPage = null; dom.location.pathname = '/';
  activateDetailView({ view: 'task', key: 'task-20' }); ui.hookCatalogue = catalogue;
});
afterAll(() => { closeDialog(); dom.restore(); });

test('four stages are one-click buttons with saved endpoint and included stages; management is collapsed and no directory read is needed', () => {
  ui.hookCatalogue = null;
  for (const level of levels) {
    const section = workerHooks(taskFor(level), { refresh() {} }); root().replaceChildren(section);
    expect(section.querySelectorAll('.hook-completion-level').map(button => button.textContent)).toEqual(['关闭', '合并', '验收', '归档']);
    expect(selected(section)).toEqual([level]);
    expect(section.querySelectorAll('.is-included').map(button => button.dataset.level)).toEqual(levels.slice(1, levels.indexOf(level)));
    expect(section.querySelector('select')).toBeNull(); expect(section.querySelector('input')).toBeNull();
    expect(section.querySelectorAll('button').some(button => button.textContent.includes('保存自动级别'))).toBe(false);
    const management = section.querySelector('.hook-management'); expect(Boolean(management.open)).toBe(false);
    expect(management.querySelectorAll('.hook-mount').map(row => row.dataset.hookId)).toEqual(['auto-merge', 'auto-accept', 'auto-archive']);
    expect(section.querySelector('.hook-completion-explanation')).toBeNull();
    expect(section.querySelector('.hook-builtin-step')).toBeNull();
    expect(section.querySelectorAll('.hook-completion-state').every(node => node.hidden)).toBe(true);
    expect(reads).toHaveLength(0); expect(actions).toHaveLength(0);
  }
});

test('click immediately authorizes one Worker with its revision; selecting the saved endpoint is a no-op', async () => {
  let refreshed = 0;
  const node = control(responseTask, () => { refreshed++; });
  await click(node, 'off'); expect(actions).toHaveLength(0);
  expect(choice(node, 'accept').classList.contains('agent-call')).toBe(true);
  expect(choice(node, 'accept').getAttribute('data-help')).toContain('token');
  await click(node, 'accept');
  expect(actions).toEqual([{ method: 'worker.completion', params: { id: 20, level: 'accept', expected_revision: 'mount-v1' } }]);
  expect(selected(node)).toEqual(['accept']); expect(refreshed).toBe(1);
  await click(node, 'merge'); expect(actions.at(-1).params.expected_revision).toBe('mount-v2');
});

test('child minimum only disables off, explains on focusable host and allows higher explicit authorization', async () => {
  responseTask = taskFor('merge', { task_kind: 'child', auto_merge: { enabled: true, locked: true, editable: false }, completion: { min_level: 'merge', locked: true } });
  const node = control(); expect(choice(node, 'off').disabled).toBe(true);
  expect(choice(node, 'off').parentNode.tabIndex).toBe(0);
  expect(choice(node, 'off').parentNode.getAttribute('data-help')).toContain('不能关闭');
  await click(node, 'off'); expect(actions).toHaveLength(0);
  expect(choice(node, 'accept').disabled).toBe(false); await click(node, 'accept');
  expect(actions[0].params.level).toBe('accept'); expect(choice(node, 'accept').getAttribute('data-help')).toContain('不继承');
});

test('merged and accepted Workers can raise the level without Agent cost or old auto-merge toggle gates', async () => {
  for (const status of ['awaiting_acceptance', 'completed']) {
    responseTask = taskFor('merge', { status, integration: 'merged', merge_readiness: { ready: true },
      auto_merge: { enabled: true, editable: false }, completion: { phase: status === 'completed' ? 'archive' : 'accept' } });
    const node = control(); expect(choice(node, 'accept').disabled).toBe(false);
    expect(choice(node, 'accept').classList.contains('agent-call')).toBe(false);
    expect(choice(node, 'accept').getAttribute('data-help')).not.toContain('消耗 token');
    expect(choice(node, 'off').disabled).toBe(true);
    await click(node, 'accept'); expect(actions.at(-1).method).toBe('worker.completion');
    await click(node, 'merge'); expect(selected(node)).toEqual(['accept']);
  }
});

test('archive confirmation describes subtree removal, preserves history and no discard; highlight stays saved until confirmed', async () => {
  const node = control(); const saving = click(node, 'archive');
  expect(actions).toHaveLength(0); expect(selected(node)).toEqual(['off']);
  expect(deepText(dom.node('modal'))).toContain('分支及后代的 worktree/ref');
  expect(deepText(dom.node('modal'))).toContain('不丢弃未提交改动');
  expect(dialogButton(dom, '授权自动归档').classList.contains('agent-call')).toBe(true);
  await dialogButton(dom, '授权自动归档').onclick(); await saving;
  expect(actions.at(-1).params.level).toBe('archive'); expect(selected(node)).toEqual(['archive']);
});

test('cancelling archive never modifies saved authorization or leaves a staged selection', async () => {
  const node = control(); const saving = click(node, 'archive');
  await dialogButton(dom, '取消').onclick(); await saving;
  expect(actions).toHaveLength(0); expect(selected(node)).toEqual(['off']);
  expect(choice(node, 'archive').disabled).toBe(false); expect(node.getAttribute('aria-busy')).toBeNull();
});

test('leaving during confirmation blocks saving, including project changes or invalid project paths before page identity updates', async () => {
  for (const next of ['/p/2222222222222222/', '/p/invalid/', null]) {
    dom.location.pathname = '/p/1111111111111111/'; activateDetailView({ view: 'task', key: 'task-20' });
    const identity = ui.view;
    const section = workerHooks(responseTask, { refresh() {} }); root().replaceChildren(section);
    const saving = click(section, 'archive');
    if (next) { dom.location.pathname = next; expect(ui.view).toBe(identity); }
    else activateDetailView({ view: 'overview' });
    await dialogButton(dom, '授权自动归档').onclick(); await saving;
    expect(actions).toHaveLength(0); expect(choice(section, 'accept').disabled).toBe(true);
  }
});

test('late responses cannot toast or refresh another page or project; a different project Worker is not locked', async () => {
  for (const changeProject of [false, true]) {
    let resolve, owned = true, refreshed = 0;
    dom.location.pathname = '/p/1111111111111111/';
    intercept = (_path, body) => body?.method === 'worker.completion' ? new Promise(done => { resolve = done; }) : null;
    const previous = control(responseTask, () => { refreshed++; }, () => owned);
    const saving = click(previous, 'merge'); await until(() => resolve);
    expect(choice(previous, 'accept').disabled).toBe(true);
    await click(previous, 'accept'); const count = actions.length;
    if (changeProject) {
      dom.location.pathname = '/p/2222222222222222/';
      const current = control(); expect(choice(current, 'accept').disabled).toBe(false);
    } else { owned = false; activateDetailView({ view: 'overview' }); }
    dom.node('message').textContent = 'new page';
    resolve(json({ ...responseTask.hooks, completion: { ...responseTask.completion, level: 'merge' } })); await saving;
    expect(actions).toHaveLength(count); expect(refreshed).toBe(0); expect(dom.node('message').textContent).toBe('new page');
    expect(selected(previous)).toEqual(['off']);
  }
});

test('freeze, running, unknown, failures, archives and missing revision cannot bypass disabled controls', async () => {
  const options = [
    ...['requested', 'executing', 'resolving', 'blocked', 'suspended'].map(status => ({ reservation: { status } })),
    { completion: { state: 'running' } }, { completion: { state: 'unknown', last_execution: { error: '检查现场 <script>secret</script>' } } },
    { completion: { editable: false, reason: '当前安全门关闭' } }, { status: 'failed' }, { status: 'cancelled' }, { archived: true },
  ];
  for (const option of options) {
    const node = control(taskFor('merge', option));
    for (const level of levels) { expect(choice(node, level).disabled).toBe(true); expect(choice(node, level).parentNode.tabIndex).toBe(0); await click(node, level); }
    expect(actions).toHaveLength(0); expect(node.querySelector('script')).toBeNull();
    expect(node.querySelector('.hook-completion-state').hidden).toBe(false);
  }
  const missing = taskFor(); delete missing.hooks.revision;
  expect(choice(control(missing), 'accept').disabled).toBe(true);
});

test('stale saves keep actual saved endpoint and safe inline failure diagnosis; malformed responses never permit another write', async () => {
  intercept = (_path, body) => body?.method === 'worker.completion' ? { ok: false, json: async () => ({ error: 'revision conflict' }) } : null;
  const node = control(taskFor('merge', { completion: { state: 'failed', phase: 'accept', last_execution: { error: '<script>dirty</script>' } } }));
  expect(deepText(node)).toContain('<script>dirty</script>'); expect(node.querySelector('script')).toBeNull();
  await click(node, 'accept'); expect(selected(node)).toEqual(['merge']); expect(dom.node('error').textContent).toContain('revision conflict');
  intercept = (_path, body) => body?.method === 'worker.completion' ? json({ worker_id: 999, revision: 'mount-v2', completion: { level: 'archive' } }) : null;
  await click(node, 'accept'); expect(selected(node)).toEqual(['merge']); expect(choice(node, 'accept').disabled).toBe(true);
  expect(dom.node('error').textContent).toContain('勿重复提交');
});

test('old services with missing or null completion retain only the original auto-merge control and project guard', async () => {
  for (const explicitNull of [false, true]) {
    const old = taskFor(); delete old.completion; delete old.hooks.completion;
    if (explicitNull) old.hooks.completion = null;
    old.hooks.mounts = [old.hooks.mounts[0]];
    const section = workerHooks(old, { refresh() {} }); root().replaceChildren(section);
    expect(section.querySelector('.hook-completion-level')).toBeNull(); expect(section.querySelectorAll('input')).toHaveLength(1);
    const input = section.querySelector('input'); input.checked = true; await input.onchange();
    expect(actions.at(-1)).toEqual({ method: 'worker.auto_merge', params: { id: 20, enabled: true } });
  }
  dom.location.pathname = '/p/1111111111111111/'; const old = taskFor(); delete old.completion; delete old.hooks.completion;
  const input = workerHooks(old, { refresh() {} }).querySelector('input');
  dom.location.pathname = '/p/2222222222222222/'; const count = actions.length; input.checked = true; await input.onchange();
  expect(actions).toHaveLength(count); expect(input.checked).toBe(false);
});

test('detailed chain explanations live on project Hooks page; builtin-only actions stay excluded from custom editor', async () => {
  await openHooks(); expect(deepText(root())).toContain('仅内置自动链 · 不可自定义安装');
  expect(deepText(root())).toContain('不保证业务质量'); expect(deepText(root())).toContain('不丢弃未提交改动');
  expect(deepText(root())).toContain('只提醒下一人工环节');
  const form = createHookForm(catalogue, { initial: { name: '规则', trigger: 'delivery.integrated' } });
  const type = form.node.querySelector('[aria-label="动作类型"]'); expect(type.children.map(option => option.value)).toEqual(['notify']);
  type.value = 'accept_worker'; expect(form.validate()).toContain('不支持所选动作');
  const trigger = form.node.querySelector('[aria-label="触发节点"]'); trigger.value = 'worker.accepted'; trigger.onchange();
  expect(type.children.map(option => option.value)).not.toContain('archive_worker');
});

test('compact graph entry remains read-only and shares highest level', () => {
  const compact = workerHooks(taskFor('accept'), { compact: true }); expect(deepText(compact)).toContain('自动链：自动到验收');
  expect(compact.querySelector('select')).toBeNull(); expect(compact.querySelector('input')).toBeNull();
  expect(compact.querySelector('button').classList.contains('agent-call')).toBe(false);
});

test('detail polling preserves in-flight authorization and open management, while refreshing results when idle', async () => {
  const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
  let resolve;
  intercept = (_path, body) => body?.method === 'worker.completion' ? new Promise(done => { resolve = done; }) : null;
  renderDetail(responseTask, null, null, null);
  const section = root().querySelector('.worker-hooks'); section.querySelector('.hook-management').open = true;
  const saving = click(section, 'accept'); await until(() => resolve);
  expect(section.dataset.completionEditing).toBe('true');
  renderDetail({ ...responseTask, hooks: { ...responseTask.hooks, revision: 'mount-v2' } }, null, null, null);
  expect(root().querySelector('.worker-hooks')).toBe(section); expect(selected(section)).toEqual(['off']);
  resolve(json({ ...responseTask.hooks, completion: { ...responseTask.completion, level: 'accept' } })); await saving;
  expect(section.dataset.completionEditing).toBe('false');
  renderDetail(responseTask, null, null, null);
  expect(root().querySelector('.worker-hooks')).not.toBe(section); expect(root().querySelector('.hook-management').open).toBe(true);
  root().querySelector('.hook-management').open = false; renderDetail(responseTask, null, null, null);
  expect(Boolean(root().querySelector('.hook-management').open)).toBe(false);
});
