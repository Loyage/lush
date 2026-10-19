import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { repo, until } from '../helpers.js';
import { setup, fetch as httpFetch } from './harness.js';
import { managementToolCLI } from '../agent/management-tool-cli-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { renderManagementCalls } from '../../src/ui/web/assets/render-management-calls.js';
import { createCallDiagnostic } from '../../src/ui/web/assets/management-call-diagnostic.js';
import { callDiagnosticReport, diagnosticSummaryLines, diagnosticCopyText, safeBrowserDiagnostic } from '../../src/ui/web/assets/management-diagnostic-model.js';
import { managementDiagnostic, MANAGEMENT_DIAGNOSTIC_CODES, MANAGEMENT_DIAGNOSTIC_ENUMS } from '../../src/core/management-diagnostic.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';
import { callStatus } from '../../src/ui/web/assets/management-calls-model.js';

const task = { id: 77, worker_number: 'V19', status: 'cancelled', management: { state: 'unknown', enabled: false, emergency: { status: 'isolated' } } };
const failedRow = { call_id: 10, receipt_id: 11, method: 'input.emit', status: 'unknown', diagnostic: managementDiagnostic('execution_failed', 'execution', 'unknown', 'dispatch_entered', { actor_id: 77, call_id: 10, receipt_id: 11, run_id: 8, occurrence_id: 9 }) };
const timelinePage = (items, has_more = false) => ({ version: 1, scope: 'current_project', receipt_id: 11, capability_receipt_id: 11, method: 'input.emit',
  diagnostic: failedRow.diagnostic, coverage: 'structured_management_diagnostic_only', timeline: { items, next_cursor: items.at(-1)?.seq ?? null, has_more, coverage: 'linked_safe_management_events_only' } });
const event = seq => ({ seq, type: 'management.capability_failed', status: 'unknown', diagnostic: failedRow.diagnostic });
function clipboard() {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), copies = [];
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { async writeText(value) { copies.push(value); } } }, configurable: true });
  return { copies, restore() { if (old) Object.defineProperty(globalThis, 'navigator', old); else delete globalThis.navigator; } };
}

test('one browser whitelist drives failure display/copy, ignores arbitrary reasons/output/URLs and honestly renders legacy unknown', () => {
  const unsafe = { ...failedRow, reason: 'PRIVATE-RAW', params: { token: 'PRIVATE-TOKEN' }, raw: 'PRIVATE-OUTPUT', href: 'https://PRIVATE',
    diagnostic: { ...failedRow.diagnostic, reason: 'PRIVATE-REASON', original_failure: { ...failedRow.diagnostic.original_failure, reason: 'PRIVATE-FIRST' },
      correlation: { ...failedRow.diagnostic.correlation, path: 'PRIVATE-PATH', worker_number: 'PRIVATE-NUMBER' } } };
  const report = callDiagnosticReport(unsafe, task), text = diagnosticCopyText(report);
  for (const line of diagnosticSummaryLines(report)) expect(text).toContain(line);
  expect(text).toContain('最初失败：执行回调'); expect(text).toContain('可能已生效'); expect(text).toContain('已急救隔离'); expect(text).toContain('管家已取消');
  expect(text).not.toContain('PRIVATE'); expect(text).toContain('V19'); expect(text).not.toContain('V77');
  const legacy = callDiagnosticReport({ call_id: 1, method: 'input.emit', status: 'unknown', error: 'PRIVATE' }, task);
  expect(diagnosticCopyText(legacy)).toContain('旧收据未采集结构化诊断');
  expect(legacy.diagnostic.original_failure).toBeNull(); expect(legacy.diagnostic.effect).toBe('unknown');
});

test('backend codes/enums remain representable in the browser and linked Workers use their actual saved numbers', () => {
  for (const code of MANAGEMENT_DIAGNOSTIC_CODES) expect(safeBrowserDiagnostic(managementDiagnostic(code, 'execution', 'unknown', 'dispatch_entered')).code).toBe(code);
  for (const [key, values] of Object.entries(MANAGEMENT_DIAGNOSTIC_ENUMS)) for (const value of values) {
    const diagnostic = { ...managementDiagnostic('execution_failed', 'execution', 'unknown', 'dispatch_entered'), [key]: value };
    expect(safeBrowserDiagnostic(diagnostic)[key]).toBe(value);
  }
  const dom = installDom(); resetUiState();
  try {
    const view = createCallDiagnostic(() => ({ current: () => true }), { events: 0, bytes: 0 });
    const row = { ...failedRow, input_emit: { coverage: 'exact_persisted_input_facts_only', mount: 'confirmed', dispatch: 'confirmed', worker_id: 1000, worker_number: 'W8-2', input_id: 3 } };
    dom.document.body.append(view.root); view.update(row, task);
    const link = view.root.querySelectorAll('a').find(node => node.getAttribute('href') === '#worker-1000');
    expect(link.textContent).toBe('关联 W8-2');
    expect(diagnosticCopyText(callDiagnosticReport(row, task))).toContain('W8-2');
    view.update({ ...row, input_emit: { ...row.input_emit, worker_number: 'PRIVATE-NUMBER' } }, task);
    expect(deepText(view.root)).not.toContain('PRIVATE');
  } finally { resetUiState(); dom.restore(); }
});

test('action/capability separation follows the fixed parent contract without losing deduplicated call identity or treating request_returned as legacy', () => {
  const cap = managementDiagnostic('succeeded', 'completion', 'applied', 'completion_saved', { receipt_id: 11, call_id: 10 });
  const action = { receipt_id: 21, action: 'start', target_id: 4, target_worker_number: 'W4', capability_receipt_id: 11,
    status: 'unknown', diagnostic: managementDiagnostic('execution_failed', 'execution', 'unknown', 'dispatch_entered', { receipt_id: 21, call_id: 10, target_id: 4 }) };
  const current = { ...task, management: { ...task.management, last_execution: { control_calls: [{ receipt_id: 11, method: 'worker.resume', diagnostic: cap }], actions: [action] } } };
  const row = { call_id: 100, receipt_id: 11, method: 'worker.resume', phase: 'finished', status: 'succeeded', diagnostic: cap,
    action: { receipt_id: 21, status: 'waiting' } };
  const report = callDiagnosticReport(row, current);
  expect(report).toMatchObject({ receipt_id: 11, capability_receipt_id: 11, action_receipt_id: 21, failed: true,
    diagnostic: { effect: 'applied', correlation: { call_id: 100, request_event_id: 100 } }, action: { status: 'unknown', diagnostic: { effect: 'unknown' } } });
  const text = diagnosticCopyText(report); expect(text).toContain('该方法已生效'); expect(text).toContain('动作最初失败：执行回调'); expect(text).toContain('结果未知');
  expect(callStatus(row, current.management)).toContain('结果未知');
  const originallyPending = { ...row, action: undefined, result: { status: 'pending_confirmation' } };
  expect(callDiagnosticReport(originallyPending, current).action?.status).toBe('unknown');
  expect(callStatus(originallyPending, current.management)).toContain('结果未知');
  const direct = { ...row, receipt_id: 21, action: 'start', result: { status: 'waiting' } };
  expect(callStatus(direct, current.management)).toContain('当前收据'); expect(callStatus(direct, current.management)).toContain('结果未知');
  const directReport = callDiagnosticReport(direct, current, { method: 'worker.resume', receipt_id: 21, capability_receipt_id: 11, action_receipt_id: 21, action, diagnostic: action.diagnostic });
  expect(directReport).toMatchObject({ receipt_id: 21, capability_receipt_id: 11, action_receipt_id: 21, action: null, diagnostic: { effect: 'unknown' } });
  const unproven = callDiagnosticReport({ method: 'worker.resume', call_id: 1, status: 'succeeded',
    diagnostic: managementDiagnostic('request_returned', 'return', 'unknown', 'completion_not_observed') }, task);
  expect(unproven.diagnostic.code).toBe('request_returned'); expect(unproven.failed).toBe(true); expect(diagnosticCopyText(unproven)).toContain('缺少独立完成证明');
});

test('real controlled Provider/bridge failure -> isolated safe HTTP receipt -> visible per-call summary and exact whitelist copy with stable source links', async () => {
  const f = await setup(); f.project.kick = () => {}; await repo(f.root);
  const c = clipboard(); let dom, section;
  try {
    f.project.scheduleInputEmissions = () => {};
    const dispatch = f.project.managementDispatch.bind(f.project);
    f.project.managementDispatch = async (method, ...args) => {
      const result = await dispatch(method, ...args);
      if (method === 'input.emit') throw new Error('PRIVATE-AFTER-MOUNT token=PRIVATE');
      return result;
    };
    const cli = managementToolCLI(f.root, 'node'); f.config.env.LUSH_PI_COMMAND = cli.command;
    f.project.provider = new AgentProvider(f.config, f.project.agentSettings);
    cli.plan([{ name: 'manager_call', params: { method: 'input.emit', params: { content: 'PRIVATE-INPUT', client_request_id: 'PRIVATE-KEY' } } }]);
    const manager = f.project.submitManagementInstruction({ instruction: '隔离诊断UI测试', profile: { agent: 'pi', config_mode: 'pi' } }).task;
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    const receipt = JSON.parse(f.store.task(manager.id).result).replies[0].response.details.receipt_id;
    await f.project.rpcDispatcher.dispatch('management.emergency_stop', { revision: f.project.managementEmergencyPreview().revision, confirm: true });
    const endpoint = `/api/management/receipt?receipt_id=${receipt}&limit=1`;
    const eventCount = f.store.get('SELECT count(*) AS n FROM events').n;
    const response = await httpFetch(f.url + endpoint), first = await response.json();
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(first).toMatchObject({ diagnostic: { original_failure: { code: 'execution_failed' }, effect: 'unknown', disposition: { emergency: 'isolated' } }, input_emit: { mount: 'confirmed', dispatch: 'not_started' } });
    for (const query of ['', `receipt_id=${receipt}&receipt_id=${receipt}`, `receipt_id=${receipt}&after=-1`, `receipt_id=${receipt}&limit=101`, `receipt_id=${receipt}&_token=PRIVATE`, `receipt_id=${receipt}&project=PRIVATE`, `receipt_id=01`]) {
      expect((await httpFetch(f.url + '/api/management/receipt?' + query)).status).toBe(400);
    }
    expect((await httpFetch(f.url + endpoint, { headers: { Origin: 'https://untrusted.example' } })).status).toBe(403);
    expect((await httpFetch(f.url + endpoint, { anonymous: true })).status).toBe(401);
    expect((await httpFetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'management.receipt', params: { receipt_id: receipt } }) })).status).toBe(400);
    expect((await httpFetch(f.url + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBeGreaterThanOrEqual(400);
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(eventCount);
    const inspected = await (await httpFetch(f.url + '/api/worker/' + manager.id)).json();
    dom = installDom({ fetch: url => httpFetch(f.url + new URL(url, 'http://fixture').pathname + new URL(url, 'http://fixture').search) }); resetUiState();
    dom.document.body.append(dom.node('detail'));
    section = renderManagementCalls(inspected); dom.node('detail').append(section);
    await until(() => section.querySelector('.management-call-failure'));
    const row = section.querySelectorAll('.management-call').find(node => deepText(node).includes('input.emit'));
    const summary = row.querySelector('.management-call-failure'), disclosure = row.querySelector('.management-call-fold');
    expect(disclosure.open).toBe(false); expect(row.querySelector('.management-call-alert').hidden).toBe(false);
    expect(summary.parentNode.parentNode).toBe(disclosure);
    disclosure.open = true; disclosure.ontoggle();
    expect(row.querySelector('.management-call-head').getAttribute('aria-expanded')).toBe('true');
    expect(summary.hidden).toBe(false); expect(section.classList.contains('management-calls-has-failures')).toBe(true);
    expect(deepText(summary)).toContain('最初失败：执行回调'); expect(deepText(summary)).toContain('底层原因未安全分类');
    expect(deepText(summary)).toContain('已急救隔离'); expect(deepText(row)).not.toContain('PRIVATE');
    expect(row.querySelectorAll('a').some(a => a.getAttribute('href') === '#input-draft-' + first.input_emit.draft_id)).toBe(true);
    expect(row.querySelectorAll('a').some(a => a.getAttribute('href')?.startsWith('#input-input-'))).toBe(false);
    await findByText(row, '复制脱敏诊断').onclick();
    const before = c.copies.at(-1);
    for (const p of summary.children.filter(p => !p.hidden)) expect(before).toContain(p.textContent);
    expect(before).not.toContain('PRIVATE'); expect(before).toContain('尚未读取');
    await findByText(row, '读取关联时间线').onclick();
    expect(deepText(row)).toContain('management.emergency_isolated');
    await findByText(row, '复制脱敏诊断').onclick();
    expect(c.copies.at(-1)).toContain('management.emergency_isolated'); expect(c.copies.at(-1)).toContain('已到本次关联范围末尾');
    const failures = section.querySelectorAll('.management-call-failure').filter(n => !n.hidden);
    expect(failures.length).toBeGreaterThan(0);
    expect(f.store.all("SELECT id FROM events WHERE type='input.emitted'")).toHaveLength(1);
    expect(f.store.all('SELECT id FROM inputs')).toHaveLength(0);
  } finally { section?.disposeCalls(); if (dom) { resetUiState(); dom.restore(); } c.restore(); await f.close(); }
});

test('real confirmed capability keeps applied submission separate from a later failed action in the HTTP UI and copied report', async () => {
  const f = await setup(); f.project.kick = () => {}; await repo(f.root);
  const c = clipboard(); let dom, section;
  try {
    const target = (await f.project.order('PRIVATE-ACTION-TARGET', 'main', [], null, false)).task;
    f.project.workspaces.busy.add(target.id);
    f.project.managementPermissionSet('worker.resume', 'confirmation', f.project.managementPermissionGet('worker.resume', 'device').revision, 'device');
    const cli = managementToolCLI(f.root, 'node'); f.config.env.LUSH_PI_COMMAND = cli.command;
    f.project.provider = new AgentProvider(f.config, f.project.agentSettings);
    cli.plan([{ name: 'manager_start', params: { worker: target.id } }]);
    const manager = f.project.submitManagementInstruction({ instruction: '隔离动作诊断UI测试', profile: { agent: 'pi', config_mode: 'pi' } }).task;
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    const pending = JSON.parse(f.store.task(manager.id).result).replies[0].response.details;
    expect(pending.status).toBe('pending_confirmation');
    await f.project.rpcDispatcher.dispatch('notice.answer', { id: pending.notice_id, answer: { answers: [{ selected: [1] }] } });
    while (f.project.managementControlJobs?.size) await Promise.all([...f.project.managementControlJobs]);
    const endpoint = '/api/management/receipt?receipt_id=' + pending.receipt_id;
    const submitted = await (await httpFetch(f.url + endpoint)).json();
    expect(submitted).toMatchObject({ diagnostic: { effect: 'applied' }, action: { status: 'waiting', diagnostic: { effect: 'not_started' } } });
    f.project.resumeTask = () => { throw new Error('PRIVATE-ACTION-FAILURE'); };
    f.project.workspaces.busy.delete(target.id); f.project.drainManagementActions();
    await f.project.rpcDispatcher.dispatch('management.emergency_stop', { revision: f.project.managementEmergencyPreview().revision, confirm: true });
    const read = await (await httpFetch(f.url + endpoint)).json();
    expect(read).toMatchObject({ diagnostic: { effect: 'applied' }, action: { status: 'unknown', diagnostic: { effect: 'unknown', original_failure: { code: 'execution_failed' } } } });
    const inspected = await (await httpFetch(f.url + '/api/worker/' + manager.id)).json();
    dom = installDom({ fetch: url => httpFetch(f.url + new URL(url, 'http://fixture').pathname + new URL(url, 'http://fixture').search) }); resetUiState();
    dom.document.body.append(dom.node('detail')); section = renderManagementCalls(inspected); dom.node('detail').append(section);
    await until(() => section.querySelector('.management-call-diagnostic'));
    const row = section.querySelectorAll('.management-call').find(node => deepText(node).includes('worker.resume'));
    const summary = row.querySelector('.management-call-failure'); expect(summary.hidden).toBe(false);
    expect(row.querySelector('.management-call-fold').open).toBe(false);
    expect(row.querySelector('.management-call-alert').textContent).toContain('未知');
    row.querySelector('.management-call-fold').open = true;
    expect(deepText(summary)).toContain('该方法已生效'); expect(deepText(summary)).toContain('关联动作：start');
    expect(deepText(summary)).toContain('结果未知'); expect(deepText(summary)).toContain('动作最初失败：执行回调');
    expect(deepText(row)).not.toContain('PRIVATE');
    expect(row.querySelectorAll('a').some(a => a.getAttribute('href') === '/api/management/receipt?receipt_id=' + read.action_receipt_id)).toBe(true);
    await findByText(row, '读取关联时间线').onclick(); await findByText(row, '复制脱敏诊断').onclick();
    for (const p of summary.children.filter(p => !p.hidden)) expect(c.copies.at(-1)).toContain(p.textContent);
    expect(c.copies.at(-1)).toContain('management.action_failed'); expect(c.copies.at(-1)).not.toContain('PRIVATE');
  } finally { section?.disposeCalls(); if (dom) { resetUiState(); dom.restore(); } c.restore(); f.project.workspaces.busy.clear(); await f.close(); }
});

test('safe receipt continuation is explicit, preserves evidence on failures, rejects missing/foreign pages and releases late reads', async () => {
  let mode = 'first', release, alive = true; const queries = [], copies = clipboard();
  const dom = installDom({ fetch: async (url, options) => {
    const q = new URL(url, 'http://fixture').searchParams; queries.push({ after: q.get('after'), signal: options.signal });
    if (mode === 'hold') return new Promise(resolve => { release = resolve; });
    if (mode === 'fail') throw new Error('PRIVATE-UNSAFE');
    if (mode === 'foreign') return Response.json({ ...timelinePage([event(99)]), diagnostic: { ...failedRow.diagnostic, correlation: { actor_id: 888 } } });
    if (mode === 'missing') return Response.json({ ...timelinePage([], true) });
    return Response.json(mode === 'first' ? timelinePage([event(12)], true) : timelinePage([event(13)]));
  } }); resetUiState();
  const controller = new AbortController(), view = createCallDiagnostic(() => ({ current: () => alive && !controller.signal.aborted, signal: controller.signal }), { events: 0, bytes: 0 });
  dom.document.body.append(view.root); view.update(failedRow, task);
  try {
    await findByText(view.root, '读取关联时间线').onclick();
    expect(queries.map(q => q.after)).toEqual(['0']); expect(deepText(view.root)).toContain('仍有后页');
    mode = 'fail'; await findByText(view.root, '继续读取关联事件').onclick();
    expect(deepText(view.root)).toContain('读取失败'); expect(deepText(view.root)).toContain('management.capability_failed'); expect(deepText(view.root)).not.toContain('PRIVATE');
    mode = 'foreign'; await findByText(view.root, '重试关联读取').onclick();
    expect(view.root.querySelector('.management-diagnostic-timeline').children).toHaveLength(1);
    mode = 'missing'; await findByText(view.root, '重试关联读取').onclick();
    expect(deepText(view.root)).toContain('读取失败');
    mode = 'next'; await findByText(view.root, '重试关联读取').onclick();
    expect(queries.map(q => q.after)).toEqual(['0','12','12','12','12']);
    expect(view.root.querySelector('.management-diagnostic-timeline').children).toHaveLength(2);
    // A fresh mounted view begins a read, then its actual page/project lifetime ends.
    const late = createCallDiagnostic(() => ({ current: () => alive, signal: controller.signal }), { events: 0, bytes: 0 });
    dom.document.body.append(late.root); late.update(failedRow, task); mode = 'hold';
    const work = findByText(late.root, '读取关联时间线').onclick(); await until(() => release);
    alive = false; controller.abort(); release(Response.json(timelinePage([event(40)]))); await work;
    expect(late.root.querySelector('.management-diagnostic-timeline').children).toHaveLength(0);
    await findByText(late.root, '复制脱敏诊断').onclick(); expect(copies.copies).toHaveLength(0);
  } finally { alive = false; controller.abort(); copies.restore(); resetUiState(); dom.restore(); }
});

test('associated timeline budget is shared and honest; oversized coverage cannot be copied as complete history', async () => {
  let queries = 0;
  const dom = installDom({ fetch: async url => {
    queries++;
    const after = Number(new URL(url, 'http://fixture').searchParams.get('after'));
    return Response.json(timelinePage(Array.from({ length: 100 }, (_, i) => event(after + i + 1)), true));
  } }); resetUiState(); const c = clipboard(), controller = new AbortController();
  try {
    const budget = { events: 0, bytes: 0 }, view = createCallDiagnostic(() => ({ current: () => true, signal: controller.signal }), budget);
    dom.document.body.append(view.root); view.update(failedRow, task);
    const read = findByText(view.root, '读取关联时间线');
    for (let n = 0; n < 10 && !read.hidden; n++) await read.onclick();
    expect(budget.events).toBeLessThanOrEqual(500); expect(budget.bytes).toBeLessThanOrEqual(512 * 1024);
    expect(read.hidden).toBe(true); expect(deepText(view.root)).toContain('范围未完成');
    const before = queries; await read.onclick(); expect(queries).toBe(before);
    await findByText(view.root, '复制脱敏诊断').onclick();
    expect(c.copies[0]).toContain('仍有未读关联事件'); expect(c.copies[0]).not.toContain('已到本次关联范围末尾');
  } finally { controller.abort(); c.restore(); resetUiState(); dom.restore(); }
});

test('actual reader project/boot change invalidates a pending associated receipt and copy', async () => {
  let release, held = false;
  const c = clipboard();
  const dom = installDom({ fetch: async url => {
    if (String(url).includes('/management/receipt')) return new Promise(resolve => { held = true; release = resolve; });
    return Response.json({ items: [{ ...failedRow, seq: 12, phase: 'finished', transport_method: 'manager.call' }], has_more: false, next_cursor: 12,
      coverage: 'trusted_management_rpc_events_only' });
  } }); resetUiState(); dom.document.body.append(dom.node('detail'));
  const section = renderManagementCalls(task); dom.node('detail').append(section);
  try {
    await until(() => section.querySelector('.management-call-diagnostic'));
    const work = findByText(section, '读取关联时间线').onclick(); await until(() => held);
    ui.workerNumbers = new Map();
    release(Response.json(timelinePage([event(100)]))); await work;
    expect(section.querySelector('.management-diagnostic-timeline').children).toHaveLength(0);
    await findByText(section, '复制脱敏诊断').onclick(); expect(c.copies).toHaveLength(0);
  } finally { section.disposeCalls(); c.restore(); resetUiState(); dom.restore(); }
});
