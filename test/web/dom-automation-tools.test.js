import { test, expect, beforeEach, afterEach } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { workerHooks } from '../../src/ui/web/assets/render-hooks.js';
import { renderOperation, validOperation, deliveryHandlerCard } from '../../src/ui/web/assets/automation-tools.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { ui } from '../../src/ui/web/assets/state.js';

let dom, reads;
beforeEach(() => {
  reads = [];
  dom = installDom({ fetch(url) { reads.push(url); throw Error('no automatic reads expected'); } });
  activateDetailView({ view: 'task', key: 'task-2' }); ui.hookCatalogue = null;
});
afterEach(() => dom.restore());
const operation = (tool, extra = {}) => ({ version: 1, id: 'op1', worker_id: 2, tool, status: 'submitted', ...extra });
const merge = extra => ({ id: 'auto-merge', name: '自动合并', trigger: 'worker.delivery_ready', mode: 'persistent', enabled: true, builtin: true,
  state: 'succeeded', actions: [{ type: 'request_merge' }], last_execution: { status: 'succeeded' }, ...extra });
function draw(mounts, extra = {}) {
  const node = workerHooks({ id: 2, task_kind: 'order', status: 'waiting', branch: 'work', integration: 'none',
    hooks: { version: 1, worker_id: 2, revision: 'r1', mounts }, ...extra });
  dom.node('detail').replaceChildren(node); return node;
}

test('request_merge Hook success only means submission, not a fabricated created Worker or landed operation', () => {
  const node = draw([merge()]);
  expect(deepText(node)).toContain('请求提交完成（尚不表示已合并）');
  expect(deepText(node)).toContain('暂无真实操作证据');
  expect(node.querySelector('.hook-operation').dataset.operationId).toBeUndefined();
  expect(node.querySelectorAll('button').some(button => button.textContent.startsWith('查看创建的 Worker'))).toBe(false);
  expect(reads).toEqual([]);
});

for (const [status, label] of [['submitted', '请求已提交'], ['waiting', '操作等待'], ['running', '操作执行中'], ['succeeded', '本轮工作收尾完成'], ['failed', '操作失败'], ['unknown', '操作结果未知']]) {
  test(`real request operation ${status} stays distinct from Hook submission and hides internal IDs/rounds/strategy`, () => {
    const node = draw([merge({ operation: operation('request_merge', { status, delivery_id: 99, round: 3, generation: 2, strategy: 'converge' }) })]);
    const result = deepText(node.querySelector('.hook-operation'));
    expect(deepText(node)).toContain('请求提交完成（尚不表示已合并）'); expect(result).toContain(label);
    for (const concept of ['交付 99', '轮次', '代次', '当前处理策略', 'request_merge', '归并']) expect(result).not.toContain(concept);
    if (status !== 'succeeded') expect(result).not.toContain('本轮工作收尾完成');
  });
}

test('no-code completion does not claim code merged or tests passed', () => {
  const node = draw([merge({ operation: operation('request_merge', { status: 'succeeded', delivery_id: 99 }) })], { result: '本轮只回答' });
  const result = deepText(node.querySelector('.hook-operation'));
  expect(result).toContain('无代码回答也可正常结束'); expect(result).toContain('代码是否合入以实际合并状态为准');
  for (const claim of ['代码已合入', '已合并', '测试通过', '交付']) expect(result).not.toContain(claim);
});

test('retired handler is absent from normal and advanced automation, but real failures remain visible', () => {
  for (const status of ['running', 'succeeded', 'failed', 'unknown']) {
    const node = draw([{ id: 'delivery-handler', kind: 'delivery_handler', name: '目标交付处理器', state: status,
      actions: [{ type: 'integrate_deliveries', strategy: 'converge' }],
      operation: operation('integrate_deliveries', { status, error: ['failed', 'unknown'].includes(status) ? '<script>保留现场</script>' : null }) }]);
    expect(node.querySelector('.delivery-handler')).toBeNull();
    expect(node.querySelector('.worker-convergence-control')).toBeNull();
    expect(deepText(node)).not.toContain('目标交付处理器');
    expect(deepText(node)).not.toContain('当前处理策略');
    if (['failed', 'unknown'].includes(status)) expect(node.querySelector('.hook-operation-alert').textContent).toContain('历史合并异常');
    expect(node.querySelector('script')).toBeNull();
  }
  const legacy = draw([{ id: 'delivery-handler', name: '旧处理器', state: 'unknown', last_execution: { error: '旧操作证据待核查' } }]);
  expect(legacy.querySelector('.hook-operation-alert').textContent).toContain('旧操作证据待核查');
  expect(reads).toEqual([]);
});

test('old handler component callers only get read-only evidence, never a supplied configuration control', () => {
  const node = deliveryHandlerCard({ control: document.createElement('button'), policy: { mounted: true, enabled: true },
    mount: { actions: [{ type: 'integrate_deliveries' }], operation: operation('integrate_deliveries', { status: 'unknown', error: '核查现场' }) } });
  expect(deepText(node)).toContain('历史合并记录'); expect(deepText(node)).toContain('核查现场');
  expect(node.querySelectorAll('button')).toHaveLength(0); expect(deepText(node)).not.toContain('当前处理策略');
});

test('acceptance requires actual operation evidence; malformed or absent evidence cannot imply success', () => {
  const good = operation('accept_worker', { status: 'succeeded' });
  const mount = { actions: [{ type: 'accept_worker' }], operation: good };
  expect(deepText(renderOperation(mount))).toContain('安全验收及资源回收完成');
  for (const value of [null, { ...good, version: 9 }, { ...good, status: 'constructor' }, { ...good, tool: 'request_merge' }, { ...good, worker_id: 0 }]) {
    mount.operation = value; expect(validOperation(value, mount)).toBe(false);
    expect(deepText(renderOperation(mount))).not.toContain('安全验收及资源回收完成');
  }
});
