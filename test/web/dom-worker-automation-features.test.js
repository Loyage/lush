import { beforeEach, afterEach, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { gate, until } from '../helpers.js';
import { workerHooks } from '../../src/ui/web/assets/render-hooks.js';
import { AUTOMATION_METADATA, automationMetadata, DISPLAY_PRINCIPLES, automationDefaultShown } from '../../src/ui/web/assets/automation-features.js';
import * as controlHelpers from '../../src/ui/web/assets/hook-controls.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { closeDialog } from '../../src/ui/web/assets/dialog.js';
import { ui } from '../../src/ui/web/assets/state.js';

const json = value => Response.json(value);
const commandId = 'dddddddd-0000-4000-8000-000000000001';
const completion = () => ({ level: 'merge', min_level: 'off', locked: false, editable: true, reason: null, phase: 'accept', state: 'waiting', last_execution: null });
function taskFor(kind = 'order', extra = {}) {
  const task = { id: 20, worker_number: 'W5', task_kind: kind, status: 'waiting', branch: kind === 'main' ? 'main' : 'feature', goal: 'work', integration: 'none',
    deps: [], dependents: [], children: [], messages: [], notices: [], ...extra };
  const level = kind === 'child' ? { ...completion(), locked: true, editable: false, min_level: 'merge', reason: 'child 流程只读' } : kind === 'main' ? null : completion();
  task.hooks = { version: 1, worker_id: task.id, revision: 'r1', completion: level,
    convergence: { version: 1, branch: task.branch, owner_id: task.id, mounted: true, enabled: false, editable: true, reason: null, revision: 'branch-r1' },
    acceptance_notice: { enabled: kind === 'order', editable: kind !== 'main', reason: kind === 'main' ? '仅指令和派生 Worker 支持' : null },
    automation_settings: { version: 1, display_principles: Object.fromEntries(AUTOMATION_METADATA.map(item => [item.id, 'all'])) },
    mounts: [] };
  return task;
}
let dom, task, writes, reads, intercept, refreshed;
beforeEach(() => {
  task = taskFor(); writes = []; reads = []; intercept = null; refreshed = 0;
  dom = installDom({ fetch: async (url, options) => {
    const path = String(url), body = options?.body ? JSON.parse(options.body) : null;
    if (body) writes.push(body); else reads.push(path);
    const overridden = intercept?.(path, body); if (overridden) return overridden;
    if (body?.method === 'worker.acceptance_notice') return json({ ...task.hooks, revision: 'r2', acceptance_notice: { ...task.hooks.acceptance_notice, enabled: body.params.enabled } });
    if (body?.method === 'branch.convergence_set') return json({ ...task.hooks.convergence, revision: 'branch-r2', mounted: body.params.mounted, enabled: body.params.enabled });
    if (body?.method === 'worker.hook_update') return json({ ...task.hooks, revision: 'r2', mounts: task.hooks.mounts.map(item => item.id === body.params.hook_id ? { ...item, enabled: body.params.enabled } : item) });
    if (path.endsWith('/api/hooks')) return json({ version: 1, revision: 'catalogue-r1', actions: [], triggers: [], templates: [],
      commands: { version: 1, revision: 'commands-r1', items: [{ id: commandId, name: 'git push', kind: 'shell', command: 'git push', version: 1 }] },
      command_example: { worker_id: 20, hook_id: 'push-mount', hooks: task.hooks } });
    throw new Error(`unexpected ${path}`);
  } });
  closeDialog(); activateDetailView({ view: 'task', key: 'task-20' }); ui.hookCatalogue = null;
});
afterEach(() => { closeDialog(); dom.restore(); });
const root = () => dom.node('detail');
const feature = id => root().querySelector(`[data-feature="${id}"]`);
const notice = () => feature('acceptance_notice').querySelector('.acceptance-notice-control');
const btn = (label, node = root()) => node.querySelectorAll('button').find(item => item.textContent === label);
const draw = (value = task, refresh = () => { refreshed++; }) => { task = value; const node = workerHooks(task, { refresh }); root().replaceChildren(node); return node; };
const choice = enabled => notice().querySelector(`[data-notice-enabled="${enabled}"]`);

test('shared metadata re-exports keep one source; user display excludes internally-created Workers and all stays the initial default', () => {
  for (const [name, value] of Object.entries({ AUTOMATION_METADATA, automationMetadata, DISPLAY_PRINCIPLES, automationDefaultShown })) {
    expect(controlHelpers[name]).toBe(value);
  }
  for (const kind of ['main', 'owner', 'order', 'say', 'child', 'analysis', 'merge', 'integration', 'management', 'unknown']) {
    const worker = { task_kind: kind };
    expect(automationDefaultShown('completion', worker, { completion: 'user' })).toBe(['main', 'owner', 'order', 'say'].includes(kind));
    expect(automationDefaultShown('completion', worker, { completion: 'main' })).toBe(['main', 'owner'].includes(kind));
    expect(automationDefaultShown('completion', worker, undefined)).toBe(true);
    expect(automationDefaultShown('completion', worker, { completion: 'all' })).toBe(true);
  }
  expect(readFileSync(new URL('../../src/ui/web/assets/automation-features.js', import.meta.url), 'utf8')).not.toContain('export const AUTOMATION_METADATA =');
});

test('all four known features directly show current controls; principle and records remain opt-in, without speculative reads', () => {
  draw();
  expect(root().querySelectorAll('.worker-automation-feature')).toHaveLength(4);
  for (const item of AUTOMATION_METADATA) {
    const node = feature(item.id); expect(deepText(node)).toContain(item.name); expect(deepText(node)).toContain(item.description);
    expect(node.querySelector('.worker-automation-feature-body').hidden).toBe(false);
    expect(node.querySelector('.worker-feature-principle').open).not.toBe(true);
    expect(node.querySelector('.worker-feature-principle').querySelector('p').textContent).toBe(item.principle);
    const toggle = node.querySelector('.worker-feature-toggle'); expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('aria-controls')).toBe(node.querySelector('.worker-automation-feature-body').id);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  }
  expect(btn('查看 main 自动化')).toBeTruthy(); expect(deepText(feature('push'))).toContain('本 Worker 不挂载或执行');
  expect(choice(true).getAttribute('aria-pressed')).toBe('true'); expect(choice(false).classList.contains('agent-call')).toBe(false);
  expect(root().querySelector('.hook-management').hidden).toBe(true); expect(reads).toEqual([]); expect(writes).toEqual([]);
});

test('main/all/user fold each feature independently; excluded features retain names and explicit entry, never change authorization', async () => {
  for (const kind of ['main', 'order', 'child']) {
    activateDetailView({ view: 'task', key: `${kind}-${Math.random()}` }); task = taskFor(kind);
    task.hooks.automation_settings.display_principles = { completion: 'main', push: 'all', convergence: 'user', acceptance_notice: 'main' };
    draw();
    expect(feature('completion').querySelector('.worker-automation-feature-body').hidden).toBe(kind !== 'main');
    expect(feature('push').querySelector('.worker-automation-feature-body').hidden).toBe(false);
    expect(feature('convergence').querySelector('.worker-automation-feature-body').hidden).toBe(kind === 'child');
    expect(feature('acceptance_notice').querySelector('.worker-automation-feature-body').hidden).toBe(kind !== 'main');
    if (kind !== 'main') {
      await feature('completion').querySelector('.worker-feature-toggle').onclick();
      expect(feature('completion').querySelector('.worker-automation-feature-body').hidden).toBe(false);
    } else {
      expect(deepText(feature('completion'))).toContain('此功能不适用'); expect(deepText(feature('acceptance_notice'))).toContain('此告知不适用');
      expect(feature('acceptance_notice').querySelector('.acceptance-notice-control')).toBeNull();
    }
  }
  expect(writes).toEqual([]); expect(reads).toEqual([]);
});

test('main and owner never acquire completion or notice controls from an incompatible historical projection', () => {
  for (const kind of ['main', 'owner']) {
    activateDetailView({ view: 'task', key: `inapplicable-${kind}` });
    const value = taskFor(kind); value.hooks.completion = completion();
    draw(value);
    expect(feature('completion').querySelector('.hook-completion-control')).toBeNull();
    expect(feature('acceptance_notice').querySelector('.acceptance-notice-control')).toBeNull();
    expect(deepText(feature('completion'))).toContain('此功能不适用');
    expect(deepText(feature('acceptance_notice'))).toContain('此告知不适用');
  }
  expect(writes).toEqual([]);
});

test('same-view Worker refresh preserves explicit folding and open principle/records, while untouched features follow fresh policy', async () => {
  draw(); await feature('completion').querySelector('.worker-feature-toggle').onclick();
  feature('completion').querySelector('.worker-feature-principle').open = true;
  const next = structuredClone(task); next.hooks.automation_settings.display_principles.convergence = 'main'; draw(next);
  expect(feature('completion').querySelector('.worker-automation-feature-body').hidden).toBe(true);
  expect(feature('completion').querySelector('.worker-feature-principle').open).toBe(true);
  expect(feature('convergence').querySelector('.worker-automation-feature-body').hidden).toBe(true);
  activateDetailView({ view: 'task', key: 'task-21' }); next.id = 21; next.hooks.worker_id = 21; draw(next);
  expect(feature('completion').querySelector('.worker-automation-feature-body').hidden).toBe(false);
  expect(feature('completion').querySelector('.worker-feature-principle').open).not.toBe(true);
});

test('failure and unknown completion/target evidence remain outside policy-folded cards', () => {
  task.hooks.automation_settings.display_principles = Object.fromEntries(AUTOMATION_METADATA.map(item => [item.id, 'main']));
  task.hooks.completion = { ...completion(), state: 'unknown', last_execution: { error: '<script>检查现场</script>' } };
  task.hooks.mounts = [{ id: 'delivery-handler', kind: 'delivery_handler', name: '交付处理器', actions: [{ type: 'integrate_deliveries' }],
    operation: { version: 1, id: 'op-1', tool: 'integrate_deliveries', worker_id: 20, status: 'failed', error: '固定落地失败' } }];
  const node = draw();
  expect(feature('completion').querySelector('.worker-automation-feature-body').hidden).toBe(true);
  expect(node.querySelector('.worker-hooks-row').querySelector('.hook-completion-alert').textContent).toContain('检查现场');
  expect(node.querySelector('.worker-hooks-row').querySelector('.hook-operation-alert').textContent).toContain('固定落地失败');
  expect(root().querySelector('script')).toBeNull(); expect(writes).toEqual([]);
});

test('folded convergence keeps authoritative failure counts and reasons visible without any operation mount', async () => {
  task.hooks.automation_settings.display_principles.convergence = 'main';
  task.hooks.convergence = { ...task.hooks.convergence, reason: '落地现场需要核查', counts: { failed: 2, blocked: 1 } };
  draw();
  expect(feature('convergence').querySelector('.worker-automation-feature-body').hidden).toBe(true);
  const diagnostic = root().querySelector('.worker-hooks-row').querySelector('.hook-convergence-alert');
  expect(diagnostic.hidden).toBe(false); expect(diagnostic.textContent).toContain('落地现场需要核查');
  expect(diagnostic.textContent).toContain('失败 2'); expect(diagnostic.textContent).toContain('落地待核查 1');
  const healthy = structuredClone(task); healthy.hooks.convergence.reason = null; healthy.hooks.convergence.counts = { failed: 0, blocked: 0 };
  draw(healthy); expect(root().querySelector('.hook-convergence-alert').hidden).toBe(true);
  expect(reads).toEqual([]); expect(writes).toEqual([]);
});

test('child notice is independently editable but completion remains locked; exact worker revision and ACK update saved state', async () => {
  draw(taskFor('child'));
  expect(feature('completion').querySelectorAll('.hook-completion-level').every(node => node.disabled)).toBe(true);
  expect(choice(true).disabled).toBe(false); expect(choice(true).getAttribute('data-help')).toContain('不调用 Agent');
  await choice(true).onclick();
  expect(writes).toEqual([{ method: 'worker.acceptance_notice', params: { id: 20, enabled: true, expected_revision: 'r1' } }]);
  expect(choice(true).getAttribute('aria-pressed')).toBe('true'); expect(refreshed).toBe(1);
  await choice(true).onclick(); expect(writes).toHaveLength(1);
  await choice(false).onclick(); expect(writes[1].params.expected_revision).toBe('r2');
  expect(feature('completion').querySelectorAll('.hook-completion-level').every(node => node.disabled)).toBe(true);
});

test('missing new fields keep old controls and explicitly unknown notice without inventing editable authorization', () => {
  delete task.hooks.acceptance_notice; delete task.hooks.automation_settings; draw();
  expect(deepText(notice())).toContain('状态尚未确认'); expect(notice().querySelector('button')).toBeNull();
  expect(deepText(root())).toContain('默认显示原则尚未提供'); expect(writes).toEqual([]);
});

test('frozen/ended/archived and server-read-only notice switches keep keyboard-accessible reasons, resisting stale callbacks', async () => {
  for (const extra of [{ reservation: { status: 'requested' } }, { status: 'failed' }, { status: 'cancelled' }, { archived: true }, { status: 'completed' }]) {
    draw(taskFor('order', extra));
    expect(choice(false).disabled).toBe(true); expect(choice(false).parentNode.tabIndex).toBe(0); expect(choice(false).parentNode.getAttribute('data-help').length).toBeGreaterThan(0);
    await choice(false).onclick();
  }
  task = taskFor(); task.hooks.acceptance_notice.editable = false; task.hooks.acceptance_notice.reason = '父同步暂停'; draw();
  expect(choice(false).parentNode.getAttribute('data-help')).toContain('父同步暂停'); await choice(false).onclick(); expect(writes).toEqual([]);
});

test('notice switch is single-flight; malformed/wrong-worker/wrong-value responses and errors never enable repeats or claim success', async () => {
  const invalid = [{}, { ...task.hooks, worker_id: 99 }, { ...task.hooks, acceptance_notice: { enabled: true, editable: true, reason: null } }];
  for (const response of invalid) {
    draw(taskFor()); intercept = (_path, body) => body?.method === 'worker.acceptance_notice' ? json(response) : null;
    const oldMessage = dom.node('message').textContent; await choice(false).onclick();
    expect(choice(false).getAttribute('aria-pressed')).toBe('false'); expect(choice(false).disabled).toBe(true);
    expect(dom.node('error').textContent).toContain('勿重复提交'); expect(dom.node('message').textContent).toBe(oldMessage);
    const count = writes.length; await choice(false).onclick(); expect(writes).toHaveLength(count);
  }
  draw(taskFor()); intercept = (_path, body) => body?.method === 'worker.acceptance_notice' ? Response.json({ error: 'revision conflict' }, { status: 409 }) : null;
  await choice(false).onclick(); expect(deepText(notice())).toContain('revision conflict'); expect(choice(false).disabled).toBe(true);
  draw(taskFor()); const pending = gate(); intercept = (_path, body) => body?.method === 'worker.acceptance_notice' ? pending.promise : null;
  const saving = choice(false).onclick(); await until(() => notice().getAttribute('aria-busy') === 'true');
  const count = writes.length; await choice(false).onclick(); expect(writes).toHaveLength(count);
  pending.resolve(json({ ...task.hooks, revision: 'r2', acceptance_notice: { enabled: false, editable: true, reason: null } })); await saving;
});

test('polling keeps in-flight notice node; cross-page/project late ACK cannot toast or refresh other views', async () => {
  const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
  renderDetail(task, null, null, null); const old = root().querySelector('.worker-hooks');
  const pending = gate(); intercept = (_path, body) => body?.method === 'worker.acceptance_notice' ? pending.promise : null;
  const saving = choice(false).onclick(); renderDetail({ ...task, hooks: { ...task.hooks, revision: 'newer' } }, null, null, null);
  expect(root().querySelector('.worker-hooks')).toBe(old);
  const ack = { ...task.hooks, revision: 'r2', acceptance_notice: { enabled: false, editable: true, reason: null } };
  activateDetailView({ view: 'overview' }); root().replaceChildren(document.createTextNode('next view')); dom.node('message').textContent = 'new view';
  pending.resolve(json(ack)); await saving; expect(refreshed).toBe(0); expect(deepText(root())).toBe('next view'); expect(dom.node('message').textContent).toBe('new view');
  for (const path of ['/p/2222222222222222/', '/p/invalid/']) {
    dom.location.pathname = '/p/1111111111111111/'; activateDetailView({ view: 'task', key: 'task-20' }); const oldNode = draw();
    const later = gate(); intercept = () => later.promise; const lateSave = choice(false).onclick();
    dom.location.pathname = path; dom.node('message').textContent = 'next project'; later.resolve(json(ack)); await lateSave;
    expect(refreshed).toBe(0); expect(dom.node('message').textContent).toBe('next project'); expect(oldNode.querySelector('.acceptance-notice-state').textContent).not.toContain('已保存');
  }
});

test('changing the document drops late notice ACK, and concurrent feature callbacks cannot compete for a Hook revision', async () => {
  draw(); const pending = gate(); intercept = (_path, body) => body?.method === 'worker.acceptance_notice' ? pending.promise : null;
  const saving = choice(false).onclick();
  const old = root().querySelector('.worker-hooks'), completion = feature('completion').querySelector('[data-level="off"]');
  await completion.onclick(); expect(writes).toHaveLength(1);
  const replacement = installDom();
  try {
    replacement.node('message').textContent = 'another document';
    pending.resolve(json({ ...task.hooks, revision: 'r2', acceptance_notice: { enabled: false, editable: true, reason: null } })); await saving;
    expect(replacement.node('message').textContent).toBe('another document'); expect(refreshed).toBe(0);
    expect(old.querySelector('[data-notice-enabled="false"]').getAttribute('aria-pressed')).toBe('false');
  } finally { replacement.restore(); }
});

test('confirmed notice save and failed refresh are separate facts, with no repeat of the already-saved value', async () => {
  draw(taskFor(), async () => { throw new Error('refresh offline'); }); await choice(false).onclick();
  expect(choice(false).getAttribute('aria-pressed')).toBe('true'); expect(deepText(notice())).toContain('已保存，但刷新失败');
  await choice(false).onclick(); expect(writes).toHaveLength(1);
});

test('unmounted convergence has a direct explicit authorized mount action, no guessed strategy or custom tool installation', async () => {
  task.hooks.convergence.mounted = false; draw(); const control = btn('挂载并开启归并');
  expect(control.classList.contains('agent-call')).toBe(true); expect(control.getAttribute('data-help')).toContain('token');
  const cancelled = control.onclick(); await dialogButton(dom, '取消').onclick(); await cancelled; expect(writes).toEqual([]);
  const mounting = control.onclick(); await dialogButton(dom, '确认挂载并开启').onclick(); await mounting;
  expect(writes).toEqual([{ method: 'branch.convergence_set', params: { branch: 'feature', mounted: true, enabled: true, expected_revision: 'branch-r1' } }]);
  expect(refreshed).toBe(1);
});

test('main push uses exact stable identity, direct current switch and protected confirmation; deleted identities never re-install', async () => {
  task = taskFor('main'); task.hooks.push = { worker_id: 20, hook_id: 'push-mount' };
  task.hooks.mounts = [{ id: 'push-mount', name: '推送', trigger: 'worker.merge_received', mode: 'persistent', enabled: false, editable: true, removable: true,
    actions: [{ type: 'command', command_id: commandId }], state: 'idle' }];
  draw(); expect(reads).toEqual([]); expect(deepText(feature('push'))).toContain('当前 main 推送：关闭');
  expect(btn('开启推送').classList.contains('agent-call')).toBe(false);
  const opening = btn('开启推送').onclick(); await until(() => dialogButton(dom, '启用指令 Hook'));
  await dialogButton(dom, '启用指令 Hook').onclick(); await opening;
  expect(writes).toEqual([{ method: 'worker.hook_update', params: { id: 20, hook_id: 'push-mount', enabled: true, expected_revision: 'r1' } }]);
  expect(deepText(feature('push'))).toContain('当前 main 推送：开启');
  task.hooks.mounts = []; draw(); expect(btn('开启推送')).toBeUndefined(); expect(deepText(feature('push'))).toContain('不会自动重装');
});

test('legacy main explicitly reads push identity and releases the resulting direct switch, without guessing or mounting', async () => {
  task = taskFor('main');
  task.hooks.mounts = [{ id: 'push-mount', name: '推送', trigger: 'worker.merge_received', mode: 'persistent', enabled: false, editable: true, removable: true,
    actions: [{ type: 'command', command_id: commandId }], state: 'idle' }];
  draw(); expect(btn('开启推送')).toBeUndefined(); expect(reads).toEqual([]);
  await btn('读取推送设置').onclick();
  expect(reads).toEqual(['/api/hooks']); expect(btn('开启推送').disabled).toBe(false); expect(writes).toEqual([]);
  expect(deepText(feature('push'))).toContain('当前 main 推送：关闭');
});

test('compact graph still owns only existing highest-stage controls, not new feature editors', () => {
  const node = workerHooks(task, { compact: true });
  expect(node.querySelectorAll('.hook-completion-level')).toHaveLength(3);
  expect(node.querySelector('.worker-automation-features')).toBeNull(); expect(node.querySelector('.acceptance-notice-control')).toBeNull();
});

test('narrow-screen feature styles keep single columns, wrapping controls, focus rings and theme tokens', () => {
  const css = readFileSync(new URL('../../src/ui/web/assets/styles-hooks.css', import.meta.url), 'utf8');
  for (const expected of ['.worker-automation-features { display: grid; grid-template-columns: minmax(0, 1fr)', '.worker-automation-feature-body[hidden]',
    '.worker-automation-feature-head h3', '.worker-feature-toggle:focus-visible', '.worker-automation-feature .hook-completion-levels { flex-wrap: wrap; max-width: 100%; }', 'background: var(--panel)']) expect(css).toContain(expected);
});
