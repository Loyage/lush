import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { gate, until } from '../helpers.js';

const json = value => ({ ok: true, json: async () => structuredClone(value) });
const fail = error => ({ ok: false, json: async () => ({ error }) });
const counts = () => ({ preparing: 0, resolving: 0, awaiting: 0, validating: 0, ready: 0, landing: 0, failed: 0, blocked: 0 });
const policy = (id = 1, patch = {}) => ({ version: 1, branch: id === 1 ? 'main' : 'order', owner_id: id, mounted: true, enabled: false, revision: `branch-${id}`, editable: true, reason: null, counts: counts(), ...patch });
const operation = (tool = 'integrate_deliveries', patch = {}) => ({ version: 1, id: 'operation-1', tool, status: 'waiting', worker_id: 1,
  strategy: tool === 'integrate_deliveries' ? 'serial' : undefined, created_at: '2026-10-12T00:00:00Z', ...patch });
const handler = (patch = {}) => ({ id: 'delivery-handler', kind: 'delivery_handler', name: '处理已授权交付', builtin: true, enabled: true,
  editable: false, removable: false, mode: 'persistent', state: 'idle', trigger: 'delivery.requested', actions: [{ type: 'integrate_deliveries', strategy: 'serial' }], operation: null, ...patch });
const merge = patch => ({ id: 'auto-merge', name: '自动合并', builtin: true, enabled: true, trigger: 'worker.delivery_ready', mode: 'persistent', state: 'succeeded',
  actions: [{ type: 'request_merge' }], last_execution: { id: 90, status: 'succeeded', worker_id: 1, created_at: '2026-10-12T00:00:00Z' }, operation: null, ...patch });
const hooks = (id, patch = {}) => ({ version: 1, worker_id: id, revision: 'hooks-r1', mounts: [handler()], convergence: policy(id), ...patch });
let catalogue, actions, reads, intercept, policies, models;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null;
  if (body) actions.push(body); else reads.push(path);
  const override = intercept?.(path, body); if (override) return override;
  const parsed = new URL(path, 'http://localhost'), target = parsed.searchParams.get('branch');
  if (path.endsWith('/api/hooks')) return json(catalogue);
  if (parsed.pathname.endsWith('/api/branch-convergence/runs')) return json({ version: 1, branch: target, items: [], has_more: false, next_before: null });
  if (parsed.pathname.endsWith('/api/branch-convergence')) return json(target ? policies.find(item => item.branch === target)
    : { version: 1, items: policies, count: policies.length, truncated: false, defaults: { version: 1, mounted: false, enabled: false, editable: true, reason: null, revision: 'defaults-r1' } });
  const worker = parsed.pathname.match(/\/api\/worker\/(\d+)\/hooks$/); if (worker) return json(models.get(Number(worker[1])));
  if (body?.method === 'branch.convergence_set') {
    const p = policies.find(item => item.branch === body.params.branch); Object.assign(p, { mounted: body.params.mounted, enabled: body.params.enabled, revision: 'saved' });
    models.get(p.owner_id).mounts[0].actions[0].strategy = p.enabled && p.mounted ? 'converge' : 'serial'; return json(p);
  }
  throw new Error(`unexpected ${path} ${body?.method}`);
} });
const { openHooks, workerHooks } = await import('../../src/ui/web/assets/render-hooks.js');
const { renderAutomationTools, renderOperation, validOperation } = await import('../../src/ui/web/assets/automation-tools.js');
const { createHookForm } = await import('../../src/ui/web/assets/hook-form.js');
const { renderBranchConvergence } = await import('../../src/ui/web/assets/branch-convergence.js');
const { renderHistory } = await import('../../src/ui/web/assets/render-history.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const root = () => dom.node('detail');
const btn = (label, node = root()) => node.querySelectorAll('button').find(item => item.textContent === label);
const field = label => root().querySelector(`[aria-label="${label}"]`);
function worker(model, patch = {}, options = {}) {
  activateDetailView({ view: 'task', key: `task-${model.worker_id}` });
  const node = workerHooks({ id: model.worker_id, task_kind: 'order', branch: policy(model.worker_id).branch, status: 'waiting', hooks: model, ...patch }, { refresh() {}, ...options });
  root().replaceChildren(node); return node;
}
async function project() { await openHooks(); await root().querySelector('.branch-convergence').ready; }
beforeEach(() => {
  ui.hooksPage?.convergenceNode?.dispose?.(); ui.hooksPage?.shortcutNode?.dispose?.(); ui.hooksPage = null; closeDialog(); activateDetailView({ view: 'overview' });
  dom.location.pathname = '/'; actions = []; reads = []; intercept = null; policies = [policy(), policy(2)]; models = new Map([[1, hooks(1)], [2, hooks(2)]]);
  catalogue = { version: 1, revision: 'r1', templates: [], commands: null,
    triggers: [{ id: 'worker.delivery_ready', label: '交付就绪' }, { id: 'delivery.requested', label: '目标接收已授权交付', description: '固定事务时选定策略' }, { id: 'delivery.integrated', label: '交付落地' }],
    actions: [{ type: 'request_merge', label: '请求合并', execution: 'operation', agent_call: true, triggers: ['worker.delivery_ready'], modes: ['persistent'] },
      { type: 'accept_worker', label: '安全验收', execution: 'operation', builtin_only: true, triggers: ['delivery.integrated'], modes: ['persistent'] },
      { type: 'integrate_deliveries', label: '处理已授权交付', execution: 'operation', builtin_only: true, agent_call: true, scope: 'target', triggers: ['delivery.requested'], modes: ['persistent'] },
      { type: 'notify', label: '告知', modes: ['once', 'persistent'] }], command_example: null };
  ui.hookCatalogue = catalogue;
});
afterAll(() => { ui.hooksPage?.convergenceNode?.dispose?.(); closeDialog(); dom.restore(); });

test('tool catalogue relates source rule, target strategy and acceptance, but cannot compose protected tools', () => {
  const directory = renderAutomationTools(catalogue); root().replaceChildren(directory);
  expect(directory.querySelectorAll('.hook-tool')).toHaveLength(4);
  for (const type of ['request_merge', 'accept_worker', 'integrate_deliveries']) expect(deepText(directory)).toContain(type);
  expect(deepText(directory)).toContain('serial'); expect(deepText(directory)).toContain('converge'); expect(deepText(directory)).toContain('固定事务时选定策略');
  expect(deepText(directory)).toContain('仅系统挂载'); expect(directory.querySelectorAll('textarea')).toHaveLength(0); expect(actions).toHaveLength(0);
  expect(deepText(directory)).toContain('不等于本轮交付完成');
  expect(deepText(directory)).not.toContain('真实合入以 operation');
  const form = createHookForm(catalogue, { initial: { trigger: 'delivery.requested' } });
  const available = form.node.querySelector('[aria-label="动作类型"]').children.map(item => item.value);
  expect(available).not.toContain('integrate_deliveries'); expect(available).not.toContain('accept_worker');
});

test('request_merge succeeded is submission only, with no invented created Worker or landed operation', () => {
  const node = worker(hooks(2, { mounts: [merge()] }));
  expect(deepText(node)).toContain('请求提交完成（非交付完成）'); expect(deepText(node)).toContain('暂无真实操作证据');
  expect(btn('查看创建的 Worker #1')).toBeUndefined(); expect(node.querySelector('.hook-operation').dataset.operationId).toBeUndefined();
  expect(deepText(node.querySelector('.hook-operation'))).not.toContain('本轮交付完成');
});

for (const [status, label] of [['submitted', '请求已提交'], ['waiting', '操作等待'], ['running', '操作执行中'], ['succeeded', '本轮交付完成'], ['failed', '操作失败'], ['unknown', '操作结果未知']]) {
  test(`real request operation ${status} is separate from Hook submission`, () => {
    const node = worker(hooks(2, { mounts: [merge({ operation: operation('request_merge', { status, worker_id: 2, delivery_id: 99, round: 3 }) })] }));
    expect(deepText(node)).toContain('请求提交完成（非交付完成）'); expect(deepText(node.querySelector('.hook-operation'))).toContain(label);
    expect(deepText(node.querySelector('.hook-operation'))).toContain('交付 99');
    if (status !== 'succeeded') expect(deepText(node.querySelector('.hook-operation'))).not.toContain('本轮交付完成');
  });
}

test('successful no-code delivery reports this round completed without claiming code merged', () => {
  // The public receipt has no no_changes field; even a successful delivery_id
  // cannot distinguish a landed code change from an answer-only delivery.
  const receipt = operation('request_merge', { status: 'succeeded', worker_id: 2, delivery_id: 99 });
  expect(receipt).not.toHaveProperty('no_changes');
  const node = worker(hooks(2, { mounts: [merge({ operation: receipt })] }), { result: '本轮仅回答，未修改代码。', integration: 'none' });
  const result = deepText(node.querySelector('.hook-operation'));
  expect(result).toContain('真实操作：本轮交付完成');
  expect(result).toContain('无代码回答也可完成交付');
  expect(result).toContain('代码合入以对应交付事实为准');
  for (const claim of ['交付合入完成', '代码已合入', '已合并']) expect(result).not.toContain(claim);
  expect(deepText(node)).toContain('请求提交完成（非交付完成）');
  expect(actions).toHaveLength(0);
});

test('failure and unknown operation diagnostics remain visible outside collapsed rule management', () => {
  for (const status of ['failed', 'unknown']) {
    const node = worker(hooks(2, { mounts: [merge({ operation: operation('request_merge', { status, error: '<script>保留现场</script>' }) })] }));
    expect(node.querySelector('.hook-management').hidden).toBe(true);
    expect(node.querySelector('.hook-operation-alert').textContent).toContain('保留现场'); expect(node.querySelector('script')).toBeNull();
    expect(btn('重试操作')).toBeUndefined();
  }
});

test('one protected handler card owns ordinary/convergence strategy and remains outside folding', () => {
  const model = hooks(1, { mounts: [handler({ builtin: false, editable: true, removable: true, actions: [{ type: 'integrate_deliveries', strategy: 'converge' }], operation: operation('integrate_deliveries', { strategy: 'converge', status: 'running', run_id: 71, generation: 2 }) })], convergence: policy(1, { enabled: true }) });
  const node = worker(model, { task_kind: 'main' }); const card = node.querySelector('.delivery-handler');
  expect(node.querySelectorAll('.delivery-handler')).toHaveLength(1); expect(node.querySelector('.hook-management').querySelector('.delivery-handler')).toBeNull();
  expect(deepText(card)).toContain('当前处理策略：归并'); expect(deepText(card)).toContain('归并批次 71'); expect(deepText(card)).toContain('不提高来源');
  for (const label of ['编辑挂载', '复制为停用挂载', '移除挂载', '停用 Hook']) expect(btn(label, card)).toBeUndefined();
  expect(btn('开启归并', card).classList.contains('agent-call')).toBe(true); expect(btn('开启归并', card).parentNode.getAttribute('data-help')).toContain('token');
  expect(btn('关闭归并', card).classList.contains('agent-call')).toBe(false);
  model.convergence.enabled = false; model.convergence.mounted = false; model.mounts[0].actions[0].strategy = 'serial';
  worker(model, { task_kind: 'main' }); expect(deepText(root().querySelector('.delivery-handler'))).toContain('当前处理策略：普通串行'); expect(btn('开启归并')).toBeUndefined();
});

test('child completion remains locked while its independent target policy is editable', () => {
  const model = hooks(2, { completion: { level: 'merge', min_level: 'merge', locked: true, editable: false, reason: 'child 流程只读', state: 'idle' } });
  const node = worker(model, { task_kind: 'child' });
  for (const control of node.querySelector('.hook-completion-levels').querySelectorAll('button')) expect(control.disabled).toBe(true);
  expect(btn('开启归并').disabled).toBe(false); expect(actions).toHaveLength(0);
});

test('target setter ACK updates shared strategy even when detail refresh fails', async () => {
  const node = worker(hooks(1), { task_kind: 'main' }, { async refresh() { throw new Error('offline'); } });
  const pending = btn('开启归并').onclick(); await dialogButton(dom, '确认开启归并').onclick(); await pending;
  expect(node.querySelector('.delivery-handler-strategy').textContent).toContain('当前处理策略：归并');
  expect(dom.node('error').textContent).toContain('已保存，但刷新失败'); expect(actions).toHaveLength(1);
});

test('accept completion requires actual operation evidence; malformed or absent evidence cannot imply success', () => {
  const mount = { actions: [{ type: 'accept_worker' }], operation: operation('accept_worker', { status: 'succeeded' }) };
  expect(deepText(renderOperation(mount))).toContain('安全验收及资源回收完成');
  for (const value of [null, { ...mount.operation, version: 9 }, { ...mount.operation, status: 'constructor' }, { ...mount.operation, tool: 'request_merge' }, { ...mount.operation, worker_id: 0 }]) {
    expect(validOperation(value, mount)).toBe(false); mount.operation = value;
    expect(deepText(renderOperation(mount))).not.toContain('安全验收及资源回收完成');
  }
});

test('project settings and history share tool directory and one target handler, refreshed snapshots do not destroy target drafts', async () => {
  models.get(1).mounts[0].operation = operation('integrate_deliveries', { status: 'unknown', error: '批次落地待核查', run_id: 71 });
  await project(); const module = root().querySelector('.branch-convergence');
  expect(module.querySelectorAll('.delivery-handler')).toHaveLength(1); expect(deepText(module)).toContain('批次落地待核查');
  const input = field('对新交付开启归并'); input.checked = true; input.onchange();
  await openHooks({ subpage: 'history' }); expect(module.querySelector('.convergence-history').hidden).toBe(false);
  expect(root().querySelector('.automation-tools').hidden).toBe(false); expect(deepText(module)).toContain('批次落地待核查');
  models.get(1).mounts[0].operation = operation('integrate_deliveries', { status: 'succeeded', strategy: 'converge', run_id: 72 });
  await btn('刷新记录').onclick(); await until(() => deepText(module).includes('目标交付处理完成'));
  await openHooks(); expect(field('对新交付开启归并')).toBe(input); expect(input.checked).toBe(true);
  expect(root().querySelector('.branch-convergence')).toBe(module); expect(deepText(module)).toContain('归并批次 72');
  expect(actions).toHaveLength(0);
});

test('late handler read for an old target cannot contaminate a newly selected target', async () => {
  const slow = gate(); intercept = path => path.endsWith('/api/worker/1/hooks') ? slow.promise : null;
  const node = renderBranchConvergence({ ownsPage: () => true, catalogue }); root().replaceChildren(node);
  await until(() => reads.some(path => path.endsWith('/api/worker/1/hooks')));
  field('目标分支').value = 'order'; await field('目标分支').onchange();
  slow.resolve(json(hooks(1, { mounts: [handler({ operation: operation('integrate_deliveries', { status: 'failed', error: 'OLD_TARGET' }) })] }))); await node.ready;
  expect(field('目标分支').value).toBe('order'); expect(deepText(node)).not.toContain('OLD_TARGET'); expect(actions).toHaveLength(0);
});

test('same-target out-of-order operation snapshots keep the newest read and the unsaved policy draft', async () => {
  const node = renderBranchConvergence({ ownsPage: () => true, catalogue }); root().replaceChildren(node); await node.ready;
  const input = field('对新交付开启归并'); input.checked = true; input.onchange();
  const slow = gate(); intercept = path => path.endsWith('/api/worker/1/hooks') ? slow.promise : null;
  node.updateCatalogue({ ...catalogue });
  intercept = null; models.get(1).mounts[0].operation = operation('integrate_deliveries', { status: 'succeeded', run_id: 72 });
  node.updateCatalogue({ ...catalogue }); await until(() => deepText(node).includes('归并批次 72'));
  slow.resolve(json(hooks(1, { mounts: [handler({ operation: operation('integrate_deliveries', { status: 'unknown', error: 'OLD_SNAPSHOT' }) })] })));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(deepText(node)).not.toContain('OLD_SNAPSHOT'); expect(field('对新交付开启归并')).toBe(input); expect(input.checked).toBe(true);
});

test('late handler response after project disposal cannot paint another project; failed reads remain explicit', async () => {
  intercept = path => path.endsWith('/api/worker/1/hooks') ? fail('目标读取失败') : null;
  await project(); expect(deepText(root())).toContain('目标操作读取失败'); expect(actions).toHaveLength(0);
  const slow = gate(); intercept = path => path.endsWith('/api/worker/1/hooks') ? slow.promise : null;
  const reading = btn('重新读取分支归并').onclick(); await until(() => reads.filter(path => path.endsWith('/api/worker/1/hooks')).length >= 2);
  ui.hooksPage.convergenceNode.dispose(); activateDetailView({ view: 'overview' }); dom.location.pathname = '/p/2222222222222222/';
  const next = document.createElement('article'); root().replaceChildren(next);
  slow.resolve(json(hooks(1, { mounts: [handler({ operation: operation('integrate_deliveries', { status: 'failed', error: 'OLD_PROJECT' }) })] }))); await reading;
  expect(root().children).toEqual([next]); expect(actions).toHaveLength(0);
});

test('event timeline keeps unified request and real-result labels, original types and unknown non-replay meaning', () => {
  const events = [
    { type: 'automation.operation_submitted', data: { tool: 'request_merge' } },
    { type: 'completion.execution_submitted', data: { phase: 'accept' } },
    { type: 'delivery.requested', data: { tool: 'integrate_deliveries', strategy: 'serial' } },
    { type: 'automation.operation_finished', data: { status: 'succeeded', tool: 'request_merge' } },
    { type: 'automation.operation_finished', data: { status: 'failed' } },
    { type: 'automation.operation_finished', data: { status: 'unknown' } },
    { type: 'automation.operation_finished', data: {} },
  ].map((event, index) => Object.freeze({ ...event, id: index + 100, created_at: '2026-10-12T00:00:00Z', data: Object.freeze(event.data) }));
  const before = structuredClone(events), timeline = renderHistory(events, { taskId: 2 }); root().replaceChildren(timeline);
  expect(timeline.children.map(item => item.querySelector('strong').textContent)).toEqual([
    '自动化操作请求已提交', '自动处理动作已提交待安全执行', '目标已接收已授权交付（未新增授权）',
    '自动化操作已完成（不代表代码合入或测试通过）', '自动化操作失败（不自动重放）',
    '自动化操作结果待核验（未知副作用不重放）', '自动化操作已结束（结果待核验，不自动重放）',
  ]);
  expect(timeline.querySelectorAll('.t-code').map(item => item.textContent)).toEqual(events.map(item => item.type));
  expect(deepText(timeline)).not.toContain('交付合入完成'); expect(events).toEqual(before);
  expect(actions).toHaveLength(0); expect(reads).toHaveLength(0);
});

test('legacy service retains branch controls without inventing a handler or operation or making new reads', async () => {
  catalogue.actions = catalogue.actions.filter(item => item.type !== 'integrate_deliveries');
  await project(); expect(btn('保存分支归并设置')).toBeTruthy(); expect(deepText(root())).toContain('兼容读面');
  expect(root().querySelector('.delivery-handler').dataset.hookId).toBeUndefined();
  expect(root().querySelector('.hook-operation')).toBeNull(); expect(reads.some(path => /\/api\/worker\/\d+\/hooks$/.test(path))).toBe(false);
  expect(deepText(root())).toContain('不制造新挂载或操作证据'); expect(actions).toHaveLength(0);
});
