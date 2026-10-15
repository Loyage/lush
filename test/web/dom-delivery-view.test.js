import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from './project-dom.js';
import { makeWorld } from './dom-world.js';
import { gate } from '../helpers.js';
const world = makeWorld();
let respond;
const dom = installDom({ fetch: (url, options) => url.startsWith('/api/worker-delivery-graph') ? respond(url, options) : world.fetchImpl(url, options) });
const { openDeliveryView, deliveryCard } = await import('../../src/ui/web/assets/render-delivery-view.js');
const { deliveryControls } = await import('../../src/ui/web/assets/render-delivery.js');
const { renderTaskGraph } = await import('../../src/ui/web/assets/render-task-graph.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { ui, resetUiState } = await import('../../src/ui/web/assets/state.js');
const { deliveryHash, deliveryTarget, deliveryStage, deliveryAttentionText } = await import('../../src/ui/web/assets/delivery-model.js');
afterAll(() => dom.restore());
const counts = { active: 3, history: 2, by_stage: { resolving: 1, blocked: 1, integrated: 2, requested: 1 } };
const summary = { version: 3, current: true, run_id: 17, delivery_id: 5, stage: 'resolving', waiting_reason: '等待整合 Worker 执行或继续',
  integration_workers: { items: [{ id: 90, worker_number: null, status: 'queued', current: true }], total: 1 }, input_queue: { buffered: 2, reason: '交付固定' }, locator: { run_id: 17, worker_id: 7 } };
const batch = { key: 'batch:17', kind: 'batch', run_id: 17, generation: 1, stage: 'resolving', target: { id: 1, worker_number: 'W1', branch: 'main' },
  waiting_reason: summary.waiting_reason, integration_workers: summary.integration_workers, member_count: 1,
  sources: [{ id: 7, worker_number: 'W5', title: '<script>unsafe</script>', parent_id: 1, delivery_summary: summary }], nodes: [{ id: 8, node_key: 'root', state: 'resolving', helper_id: 90 }], node_count: 1 };
const page = (items, more = false, history = false) => Response.json({ version: 1, history, items, counts, matched_total: history ? 2 : 3, has_more: more, cursor: more ? 'opaque-cursor' : null, truncated: more });
const click = label => dom.node('detail').querySelectorAll('button').find(node => node.textContent === label)?.onclick();

test('project-scoped activity pagination, node locate, helpers and current buffered facts; no mutations', async () => {
  resetUiState(); const calls = [];
  respond = (url, options) => { calls.push({ url, options }); return url.includes('cursor=') ? page([batch]) : page([{ ...batch, run_id: 16, key: 'batch:16' }], true); };
  await openDeliveryView({ locator: { run_id: 17, node_id: 8 } });
  expect(deepText(dom.node('detail'))).toContain('对应交付尚未读到');
  await click('继续加载');
  const root = dom.node('detail');
  expect(deepText(root)).toContain('已定位对应本轮交付');
  expect(root.querySelector('[data-delivery-key="batch:17"]').querySelector('details').open).toBe(true);
  expect(root.querySelector('[data-delivery-key="batch:17"]').querySelector('[data-delivery-node="8"]').classList.contains('delivery-located')).toBe(true);
  expect(deepText(root)).toContain('#90'); expect(deepText(root)).toContain('当前暂存输入：2 条');
  expect(root.querySelectorAll('a').some(node => node.href === '/p/aaaaaaaaaaaaaaaa/#worker-90')).toBe(true);
  expect(root.querySelectorAll('a').some(node => node.href === '/p/aaaaaaaaaaaaaaaa/#worker-graph-worker-7')).toBe(true);
  expect(calls[1].url).toContain('cursor=opaque-cursor');
  expect(calls.every(call => !call.options.method && call.options.signal)).toBe(true);
  expect(world.state.actions).toHaveLength(0); expect(root.querySelector('script')).toBeNull();
});

test('successful history is opt-in and paged; completed helper never makes active batch merged', async () => {
  resetUiState(); let reads = 0;
  respond = url => { reads++; expect(url).toContain('history=1'); return page([{ ...batch, key: `batch:${reads}`, run_id: reads, stage: 'integrated',
    commit: 'a'.repeat(40), sources: [{ ...batch.sources[0], delivery_summary: { ...summary, current: false, stage: 'integrated' } }] }], reads === 1, true); };
  await openDeliveryView({ history: true }); await click('继续加载');
  expect(dom.node('detail').querySelectorAll('.delivery-card')).toHaveLength(2);
  expect(deepText(dom.node('detail'))).toContain('非当前预约交付');
  expect(deepText(dom.node('detail'))).toContain('不自动验收或回收');
  const card = deliveryCard({ ...batch, stage: 'ready', integration_workers: { items: [{ id: 90, status: 'completed', current: true }] } });
  expect(deepText(card)).toContain('工作完成 · 等待合并'); expect(card.querySelector('.delivery-result')).toBeNull();
  expect(card.querySelectorAll('button')).toHaveLength(0);
});

test('missing/mismatch/old generation and truncation stay explicit; no ghost workers or v1/v2 actions on v3', () => {
  const card = deliveryCard({ ...batch, members_truncated: true, nodes_truncated: true,
    integration_workers: { items: [{ id: 90, status: null, current: false, missing: true, identity_mismatch: true }], total: 8, truncated: true },
    sources: [{ ...batch.sources[0], missing: true, delivery_summary: { ...summary, current: false, reservation_truncated: true, input_queue: { buffered: null } } }] });
  const text = deepText(card); for (const word of ['身份不符','旧代引用','来源成员截断','节点证据截断','暂存输入：未知','预约已截断']) expect(text).toContain(word);
  expect(card.querySelectorAll('a').some(node => node.href.endsWith('#worker-90'))).toBe(false);
  for (const version of [3, 99]) for (const kind of ['order','child']) {
    const controls = deliveryControls({ id: 7, task_kind: kind, parent_task_kind: 'main', status: 'waiting', integration: 'pending', reservation: { version, kind: 'merge', status: 'requested' }, delivery_summary: summary });
    expect(controls.querySelectorAll('button')).toHaveLength(0); expect(deepText(controls)).not.toContain('批准固定提交');
    expect(controls.querySelectorAll('a').some(link => link.href.includes('#deliveries'))).toBe(false);
    expect(deepText(controls)).not.toContain('本轮交付');
  }
  const serial = deliveryCard({ key: 'serial:7:9', kind: 'serial', stage: 'requested', target: batch.target, sources: [{ ...batch.sources[0], delivery_summary: { ...summary, version: 2, run_id: null } }] });
  expect(deepText(serial)).toContain('不创建虚构整合 Worker');
});

test('missing v3 batch locates its real serial diagnostic, not a phantom batch', async () => {
  resetUiState();
  respond = () => page([{ key: 'serial:7:5', kind: 'serial', stage: 'requested', target: batch.target,
    blocked_code: 'missing_batch', waiting_reason: '固定批次记录缺失，请核查', sources: [{ ...batch.sources[0],
      delivery_summary: { ...summary, run_id: 999, blocked_code: 'missing_batch' } }] }]);
  await openDeliveryView({ locator: { run_id: 999, worker_id: 7 } });
  const root = dom.node('detail');
  expect(root.querySelector('[data-delivery-key="serial:7:5"]')).toBeTruthy();
  expect(deepText(root)).toContain('已定位对应本轮交付');
  expect(root.querySelector('[data-delivery-source="7"]').classList.contains('delivery-located')).toBe(true);
  expect(deepText(root)).toContain('固定批次记录缺失');
  expect(deepText(root)).not.toContain('归并批次 #999');
});

test('cursor stale retains read pages, requires explicit first-page refresh, never silently retries', async () => {
  resetUiState(); let reads = 0;
  respond = url => { reads++; return url.includes('cursor=') ? Response.json({ error: 'Worker delivery graph cursor stale; refresh from first page' }, { status: 400 }) : page([batch], reads === 1); };
  await openDeliveryView(); await click('继续加载');
  expect(reads).toBe(2); expect(deepText(dom.node('detail'))).toContain('请显式从首批刷新');
  expect(dom.node('detail').querySelectorAll('.delivery-card')).toHaveLength(1);
  expect(dom.node('detail').querySelectorAll('button').some(node => node.textContent === '继续加载')).toBe(false);
  await click('从首批刷新'); expect(reads).toBe(3); expect(deepText(dom.node('detail'))).not.toContain('读取失败');
});

test('A to B/away/project change aborts reads and ignores late responses even non-cancellable transports', async () => {
  resetUiState(); const pending = gate(); let signal;
  respond = (url, options) => { signal = options.signal; return pending.promise; };
  const first = openDeliveryView(); activateDetailView({ view: 'overview' }); dom.node('detail').replaceChildren(); expect(signal.aborted).toBe(true);
  pending.resolve(page([batch])); await first;
  expect(dom.node('detail').querySelector('.delivery-view')).toBeNull();
  const another = gate(); respond = () => another.promise;
  const second = openDeliveryView(); dom.location.pathname = '/p/bbbbbbbbbbbbbbbb/';
  another.resolve(page([batch])); await second; expect(dom.node('detail').querySelector('.delivery-card')).toBeNull();
  respond = () => page([{ ...batch, key: 'batch:99', run_id: 99 }]); await openDeliveryView({ locator: { run_id: 99 } });
  expect(dom.requests.at(-1).path).toStartWith('/p/bbbbbbbbbbbbbbbb/api/worker-delivery-graph');
  expect(dom.node('detail').querySelector('[data-delivery-key="batch:99"]')).toBeTruthy();
  dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/';
});

test('work tree keeps true parent edges and whitelist; minimal source cards expose delivery inline', () => {
  resetUiState(); activateDetailView({ view: 'task-graph' });
  const nodes = [{ id: 1, task_kind: 'main', title: 'main', status: 'waiting', parent_id: null },
    { id: 7, task_kind: 'child', title: 'source', status: 'waiting', parent_id: 1, delivery_summary: summary },
    { id: 90, task_kind: 'integration', title: 'helper', status: 'queued', parent_id: 1 }];
  const graph = { nodes, edges: [{ kind: 'parent', from: 1, to: 7 }], total: 3 };
  const before = JSON.stringify(graph); renderTaskGraph(graph);
  const root = dom.node('detail'); expect(JSON.stringify(graph)).toBe(before);
  expect(root.querySelector('[data-task-id="90"]')).toBeNull();
  expect(root.querySelector('[data-task-id="7"]').querySelector('.source-delivery')).toBeTruthy();
  expect(deepText(root.querySelector('[data-task-id="7"]'))).toContain('等待整合 #90');
});

test('legacy view is explicitly historical/read-only and preserves expanded reading on refresh', async () => {
  resetUiState(); let reads = 0;
  respond = () => { reads++; return page([batch]); };
  await openDeliveryView();
  expect(deepText(dom.node('detail'))).toContain('历史合并记录');
  expect(deepText(dom.node('detail'))).toContain('旧链接只读兼容');
  const body = dom.node('detail').querySelector('.delivery-view');
  body.querySelector('details').setAttribute('open', '');
  await ui.deliveryPage.refresh();
  expect(dom.node('detail').querySelector('.delivery-view')).toBe(body);
  expect(reads).toBe(1);
});

test('attention count accepts only complete nonnegative server integers, not stages or loaded item totals', async () => {
  for (const attention of [undefined, null, -1, 1.5, '2', true, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, 0, 2, 99]) {
    resetUiState();
    const wireCounts = { ...counts, attention };
    respond = () => Response.json({ version: 1, history: false, items: [{ ...batch, attention: true }], counts: wireCounts,
      matched_total: 100, has_more: true, cursor: 'opaque-cursor', truncated: true });
    await openDeliveryView();
    const expected = Number.isSafeInteger(attention) && attention >= 0 ? `待处理 ${attention}` : '待处理统计未提供';
    expect(deliveryAttentionText(wireCounts)).toBe(expected);
    expect(dom.node('detail').querySelector('.delivery-count-summary').textContent).toBe(`活动 3 · ${expected} · 已合并历史 2`);
    expect(deepText(dom.node('detail'))).not.toContain('阶段异常');
    expect(dom.node('detail').querySelectorAll('.delivery-card')).toHaveLength(1);
  }
});

test('attention flag is authoritative; old item absence still shows real waiting diagnostics', () => {
  expect(deliveryCard({ ...batch, stage: 'ready', attention: true }).classList.contains('delivery-exception')).toBe(true);
  expect(deliveryCard({ ...batch, stage: 'blocked', attention: false }).classList.contains('delivery-exception')).toBe(false);
  const old = deliveryCard({ ...batch, waiting_reason: '等待整合 Worker 的待决答复',
    integration_workers: { items: [{ id: 90, status: 'awaiting', current: true }] } });
  expect(old.classList.contains('delivery-exception')).toBe(true); expect(deepText(old)).toContain('等待整合 Worker 的待决答复');
  expect(deliveryCard({ ...batch, integration_workers: { items: [{ id: 90, status: 'paused', current: true }] } }).classList.contains('delivery-exception')).toBe(true);
  expect(deliveryCard({ ...batch, stage: 'integrated', attention: false }).classList.contains('delivery-exception')).toBe(false);
});

test('single hash parser supports refresh/back/project deep links without guessing ids', () => {
  for (const history of [true,false]) for (const locator of [{}, { run_id: 17, node_id: 8 }, { run_id: 17, worker_id: 7 }, { worker_id: 7, delivery_id: 5 }]) {
    const parsed = deliveryTarget(deliveryHash(locator, history)); expect(parsed.history).toBe(history);
    for (const [key,value] of Object.entries(locator)) expect(parsed.locator[key]).toBe(value);
  }
  for (const hash of ['#deliveries-run-0','#deliveries-run-9007199254740992','#deliveries-source-W5','#deliveries-evil']) expect(deliveryTarget(hash)).toBeNull();
  expect(deliveryStage('integrated')).toBe('已合并'); expect(deliveryStage('landing')).toContain('尚未合并');
});
