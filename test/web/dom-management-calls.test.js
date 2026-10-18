import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { until } from '../helpers.js';
import { createCallsState, mergeCalls, callStatus } from '../../src/ui/web/assets/management-calls-model.js';
import { renderManagementCalls } from '../../src/ui/web/assets/render-management-calls.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';

const task = { id: 801, worker_number: 'V12', role: 'manager', task_kind: 'management', goal: '接口调用',
  status: 'running', calls: 1, children: [], runs: [], management: { version: 1, state: 'running' } };
const row = (id, seq = id, extra = {}) => ({ seq, call_id: id, phase: seq === id ? 'started' : 'finished',
  method: 'worker.inspect', transport_method: 'manager.call', started_at: '2026-10-18T01:00:00Z',
  run_id: 1, target_id: 4, target_worker_number: 'W4', params: { id: 4 },
  status: seq === id ? 'running' : 'succeeded', ...extra });
const page = (items, has_more = false) => ({ items, has_more, next_cursor: items[0]?.seq ?? null,
  latest_cursor: items.at(-1)?.seq ?? null, coverage: 'trusted_management_rpc_events_only', history_complete: false });

test('call identity, standalone finishes, monotonic cursors and bounded partial range', () => {
  const s = createCallsState();
  mergeCalls(s, page([row(20, 23), row(21), row(22, 24)], true), 'initial');
  mergeCalls(s, page([row(21, 25), row(26)], true), 'newer');
  mergeCalls(s, page([row(2), row(20)], false), 'older');
  expect(s.calls.get(20).phase).toBe('finished');
  expect(s.calls.get(21).seq).toBe(25); expect(s.high).toBe(26); expect(s.oldest).toBe(2);
  expect(s.hasNewer).toBe(true); expect(s.hasOlder).toBe(false);
  mergeCalls(s, page([row(2, 2, { status: 'unknown' })]), 'projection');
  expect(s.calls.get(2).status).toBe('unknown'); expect(s.high).toBe(26);
  const bounded = createCallsState({ events: 2, bytes: 10000 });
  mergeCalls(bounded, page([row(1), row(2), row(3)], true), 'initial');
  expect(bounded.calls.size).toBe(2); expect(bounded.high).toBe(2); expect(bounded.limited).toBe(true);
  const bytes = createCallsState({ events: 5000, bytes: 1 });
  mergeCalls(bytes, page([row(1)]), 'initial'); expect(bytes.calls.size).toBe(0); expect(bytes.limited).toBe(true);
});

test('RPC return is not business completion; exact capability/action receipts only', () => {
  const r = row(1, 2, { result: { status: 'pending_confirmation' }, receipt_id: 8 });
  expect(callStatus(r)).toContain('待用户确认');
  const management = { last_execution: { control_calls: [{ receipt_id: 8, method: 'worker.inspect', status: 'approved' }] } };
  expect(callStatus(r, management)).toContain('等待安全点');
  r.action = { receipt_id: 19, status: 'waiting' };
  management.last_execution.actions = [{ receipt_id: 20, status: 'succeeded' }];
  expect(callStatus(r, management)).toContain('等待安全点');
  management.last_execution.actions.push({ receipt_id: 19, status: 'unknown' });
  expect(callStatus(r, management)).toContain('结果未知');
  expect(callStatus(row(4, 4, { status: 'unknown' }))).toContain('未观察到完成');
  expect(callStatus(row(4, 5))).toContain('不代表目标业务完成');
});

test('DOM latest/older/after continuation, exact re-projection, retained nodes and retry', async () => {
  const requests = []; let fail = false, ended = false, finished = false;
  const dom = installDom({ fetch: async (url, options) => {
    const query = new URL(url, 'http://fixture').searchParams; requests.push({ query, signal: options.signal });
    if (fail) throw new Error('offline PRIVATE ERROR');
    const before = Number(query.get('before')), after = Number(query.get('after'));
    let data = !query.has('before') && !query.has('after') ? page([row(10), row(11, 12)], true)
      : before === 11 ? page([row(10, 10, { status: ended ? 'unknown' : 'running' })])
      : before === 10 ? page([row(2, 3)])
      : after === 12 ? page(finished ? [row(10, 13)] : [], !finished)
      : page([]);
    return new Response(JSON.stringify(data));
  } }); resetUiState();
  dom.document.body.append(dom.node('detail'));
  const lifetime = new AbortController();
  try {
    let section = renderManagementCalls(task, null, { signal: lifetime.signal, current: () => true }); dom.node('detail').append(section);
    await until(() => deepText(section).includes('已显示 2'));
    const first = section.querySelector('.management-call'), fold = first.querySelector('details'); fold.open = true;
    expect(requests[0].query.get('limit')).toBe('50');
    await findByText(section, '加载更早调用').onclick();
    expect(section.querySelectorAll('.management-call').map(n => n.dataset.callId)).toEqual(['2','10','11']);
    await findByText(section, '读取最新调用').onclick();
    expect(requests.at(-1).query.get('after')).toBe('12');
    expect(deepText(section)).toContain('继续读取最新调用');
    ended = true;
    section = renderManagementCalls({ ...task, status: 'completed' }, section, { current: () => true });
    await until(() => deepText(first).includes('结果未知'));
    expect(first.querySelector('details')).toBe(fold); expect(fold.open).toBe(true);
    expect(section.querySelectorAll('.management-call')).toContain(first);
    expect(requests.some(r => r.query.get('before') === '11' && r.query.get('limit') === '1')).toBe(true);
    fail = true; await section.querySelectorAll('button').find(node => node.textContent === '继续读取最新调用').onclick();
    expect(deepText(section)).toContain('不可用或失败'); expect(deepText(section)).not.toContain('PRIVATE ERROR');
    expect(section.querySelectorAll('.management-call')).toHaveLength(3);
    fail = false; finished = true; await findByText(section, '重试读取').onclick();
    expect(deepText(first)).toContain('RPC 已返回'); expect(first.querySelector('details')).toBe(fold);
    section.disposeCalls(); expect(requests[0].signal.aborted).toBe(true);
  } finally { lifetime.abort(); resetUiState(); dom.restore(); }
});

test('forward has_more reads one bounded page at a time without skipping records', async () => {
  const afters = [];
  const dom = installDom({ fetch: async url => {
    const q = new URL(url, 'http://fixture').searchParams;
    let data;
    if (!q.has('after')) data = page([row(1, 2)]);
    else {
      const after = Number(q.get('after')); afters.push(after);
      data = after === 2 ? page(Array.from({ length: 50 }, (_, i) => row(i + 3, i + 100)), true)
        : page([row(53, 150)]);
    }
    return Response.json(data);
  } }); resetUiState(); dom.document.body.append(dom.node('detail'));
  try {
    const section = renderManagementCalls(task); dom.node('detail').append(section);
    await until(() => deepText(section).includes('已显示 1'));
    const next = section.querySelectorAll('button').find(node => node.textContent === '读取最新调用');
    await next.onclick();
    expect(afters).toEqual([2]); expect(next.textContent).toBe('继续读取最新调用');
    expect(section.querySelectorAll('.management-call')).toHaveLength(51);
    await next.onclick(); expect(afters).toEqual([2,149]);
    expect(section.querySelectorAll('.management-call')).toHaveLength(52);
    expect(section.querySelectorAll('.management-call').at(-1).dataset.callId).toBe('53');
    section.disposeCalls();
  } finally { resetUiState(); dom.restore(); }
});

test('late responses, aborted lifetime, project/document identity and unavailable service never paint stale data', async () => {
  let release; const dom = installDom({ fetch: () => new Promise(resolve => { release = resolve; }) }); resetUiState();
  dom.document.body.append(dom.node('detail'));
  try {
    const controller = new AbortController();
    const section = renderManagementCalls(task, null, { current: () => true, signal: controller.signal }); dom.node('detail').append(section);
    await until(() => release); controller.abort();
    release(new Response(JSON.stringify(page([row(99)]))));
    await Promise.resolve(); await Promise.resolve();
    expect(section.querySelectorAll('.management-call')).toHaveLength(0);
    expect(deepText(section)).not.toContain('已显示 1');
    section.bindCalls(task, { current: () => true });
    release = null; await until(() => release); ui.workerNumbers = new Map();
    release(new Response(JSON.stringify(page([row(100)]))));
    await Promise.resolve(); await Promise.resolve(); expect(section.querySelectorAll('.management-call')).toHaveLength(0);
    section.disposeCalls();
  } finally { resetUiState(); dom.restore(); }
});

test('unsupported old service is unavailable, not an empty history', async () => {
  const dom = installDom({ fetch: async () => Response.json({ error: 'not found' }, { status: 404 }) }); resetUiState();
  dom.document.body.append(dom.node('detail'));
  try {
    const section = renderManagementCalls(task); dom.node('detail').append(section);
    await until(() => deepText(section).includes('旧服务可能不支持'));
    expect(deepText(section)).not.toContain('当前窗口无采集记录');
    expect(section.querySelectorAll('button').find(node => node.textContent === '重试读取').hidden).toBe(false);
    section.disposeCalls();
  } finally { resetUiState(); dom.restore(); }
});

test('full detail refresh retains call module, folds and page; only actual Valet gets the reader', async () => {
  const dom = installDom({ fetch: async () => new Response(JSON.stringify(page([row(1, 2)]))) }); resetUiState();
  dom.document.body.append(dom.node('detail'));
  try {
    const render = value => renderDetail(value, { events: [] }, null, null, null, { current: () => true });
    let patches = render(task);
    await until(() => dom.node('detail').querySelector('.management-call'));
    const section = dom.node('detail').querySelector('.management-calls'), item = section.querySelector('.management-call');
    item.querySelector('details').open = true;
    patches = render(task); await until(() => deepText(section).includes('已显示'));
    expect(dom.node('detail').querySelector('.management-calls')).toBe(section);
    expect(section.querySelector('.management-call')).toBe(item); expect(item.querySelector('details').open).toBe(true);
    const blocks = [...dom.node('detail').children];
    expect(blocks.indexOf(section)).toBe(blocks.indexOf(dom.node('detail').querySelector('.management-state')) + 1);
    patches.dispose(); render({ ...task, id: 802, role: 'agent', task_kind: 'order' }).dispose();
    expect(dom.node('detail').querySelector('.management-calls')).toBeNull();
  } finally { resetUiState(); dom.restore(); }
});
