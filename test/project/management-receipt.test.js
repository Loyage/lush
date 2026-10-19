import path from 'node:path';
import { test, expect } from 'bun:test';
import { fixture, repo, env } from '../helpers.js';
import { managementLegacyRPCProvider as managementToolCLI } from '../agent/management-legacy-rpc-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { RPCServer } from '../../src/rpc/server.js';
import { PARAMS, assertAllowed } from '../../src/rpc/registry.js';
import { createSignal } from '../../src/signal.js';
import { managementScopeError } from '../../src/core/management-guidance.js';
import { INPUT_EMIT_SCHEMA, validateInputEmissionRequest } from '../../src/core/input-emission-protocol.js';
import { managementReceipt } from '../../src/core/project/management-receipt.js';
import { beginManagementCall, finishManagementCall, managementCalls } from '../../src/core/project/management-calls.js';
import { managementState } from '../../src/core/project/management-data.js';
import { managementCatalog, managementPolicy } from '../../src/rpc/management-policy.js';
import { cliCatalog } from '../../src/rpc/cli-catalog.js';
import { MANAGEMENT_RECEIPT_CAPABILITIES, MANAGEMENT_RECEIPT_PARAMETERS, safeManagementDiagnostic,
  safeManagementDiagnosticError, MANAGEMENT_DIAGNOSTIC_CODE } from '../../src/core/management-diagnostic.js';

const actionTool = (action, worker) => ({ name: action === 'start' ? 'manager_start' : 'manager_retry', params: { worker } });
const tool = (method, params = {}, request_id) => ({ name: 'manager_call', params: { method, params, ...(request_id ? { request_id } : {}) } });
async function harness() {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  const dispatcher = new Dispatcher(f.project, createSignal(), {}), rpc = new RPCServer(f.config.socket, dispatcher); await rpc.start();
  const cli = managementToolCLI(f.root, 'node', { compactCatalog: true });
  f.config.env.LUSH_PI_COMMAND = cli.command;
  f.project.provider = new AgentProvider(f.config, f.project.agentSettings);
  const invokeProvider = f.project.provider.run.bind(f.project.provider); let observedProviderResult = null;
  f.project.provider.run = async options => {
    const result = await invokeProvider(options); observedProviderResult = result; return result;
  };
  return { ...f, dispatcher, async invoke(plan) {
    cli.plan(plan); observedProviderResult = null;
    const task = f.project.submitManagementInstruction({ instruction: '核对当前项目安全诊断 PRIVATE-INSTRUCTION', profile: { agent: 'pi', config_mode: 'pi' } }).task;
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    const result = f.store.task(task.id);
    expect(result.status).not.toBe('running');
    // Action unknown can fail the Worker during its still-live Provider call.
    // Capture the real Provider return rather than pretending Worker.result was saved.
    const output = result.result ?? observedProviderResult;
    return { task: result, replies: output ? JSON.parse(output).replies : [] };
  }, async close() { await rpc.close(); await f.close(); } };
}
const set = (f, method, access) => f.project.managementPermissionSet(method, access, f.project.managementPermissionGet(method, 'device').revision, 'device');
const isolate = async f => f.dispatcher.dispatch('management.emergency_stop', { revision: f.project.managementEmergencyPreview().revision, confirm: true });
const noPrivate = value => expect(JSON.stringify(value)).not.toContain('PRIVATE');

test('real Provider -> tool -> bridge -> failed effect -> safe receipt -> isolated history -> ordinary Valet read; unknown is not replayed', async () => {
  const f = await harness(), other = fixture();
  try {
    const dispatch = f.project.managementDispatch.bind(f.project); let executions = 0, capturedToken;
    const provider = f.project.provider.run.bind(f.project.provider);
    const foreign = new Dispatcher(other.project, createSignal(), {});
    f.project.provider.run = async options => {
      capturedToken = options.token;
      const events = other.store.get('SELECT count(*) AS n FROM events').n;
      await expect(foreign.dispatch('manager.query', { _token: options.token })).rejects.toThrow();
      expect(other.store.get('SELECT count(*) AS n FROM events').n).toBe(events);
      await expect(f.dispatcher.dispatch('management.receipt', { _token: options.token, receipt_id: 1 })).rejects.toThrow('user approval');
      return provider(options);
    };
    f.project.managementDispatch = async (method, ...args) => {
      const result = await dispatch(method, ...args);
      if (method === 'draft.add') { executions++; throw new Error('PRIVATE-EXCEPTION token=PRIVATE-TOKEN env=PRIVATE-ENV prompt=PRIVATE-PROMPT'); }
      return result;
    };
    const failed = await f.invoke([tool('draft.add', { content: 'PRIVATE-DRAFT', branch: 'main' }, 'PRIVATE-MODEL-REQUEST'),
      tool('draft.add', { content: 'PRIVATE-DRAFT', branch: 'main' }, 'PRIVATE-MODEL-REQUEST')]);
    const first = failed.replies[0].response.details, duplicate = failed.replies[1].response.details;
    expect(executions).toBe(1); expect(f.store.draftCount()).toBe(1);
    expect(first).toMatchObject({ status: 'unknown', diagnostic: { stage: 'execution', code: 'execution_failed', effect: 'unknown',
      original_failure: { code: 'execution_failed', stage: 'execution', effect: 'unknown' }, recovery: 'inspect_receipt', retry: 'not_automatic' } });
    expect(duplicate.receipt_id).toBe(first.receipt_id);
    expect(duplicate.diagnostic.correlation.call_id).not.toBe(first.diagnostic.correlation.call_id);
    expect(first.diagnostic.correlation).toMatchObject({ actor_id: failed.task.id, worker_number: failed.task.worker_number, receipt_id: first.receipt_id });
    for (const key of ['run_id','occurrence_id','call_id','request_event_id']) expect(first.diagnostic.correlation[key]).toBeGreaterThan(0);
    const before = managementReceipt(f.project, { receipt_id: first.receipt_id });
    await isolate(f);
    const isolated = managementReceipt(f.project, { receipt_id: first.receipt_id, limit: 100 });
    expect(isolated.diagnostic.original_failure).toEqual(before.diagnostic.original_failure);
    expect(isolated.diagnostic).toMatchObject({ effect: 'unknown', disposition: { worker_status: 'cancelled', binding_enabled: false, emergency: 'isolated' } });
    expect(isolated.timeline.items.map(row => row.type)).toContain('management.emergency_isolated');
    const reader = await f.invoke([tool('management.receipt', { receipt_id: first.receipt_id, limit: 1 }),
      tool('management.receipt', { receipt_id: first.diagnostic.correlation.call_id, limit: 100 }),
      tool('management.receipt', { receipt_id: first.diagnostic.correlation.call_id, project: 'PRIVATE-PROJECT' }),
      tool('management.receipt', { receipt_id: first.receipt_id, _token: 'PRIVATE-FORGED' })]);
    expect(reader.task.status).toBe('completed');
    expect(reader.replies[0].response.details.result).toMatchObject({ capability_receipt_id: first.receipt_id,
      diagnostic: { original_failure: first.diagnostic.original_failure }, timeline: { has_more: true, coverage: 'linked_safe_management_events_only' } });
    expect(reader.replies[1].response.details.result.diagnostic.original_failure).toEqual(first.diagnostic.original_failure);
    for (const reply of reader.replies.slice(2)) expect(JSON.parse(reply.error).diagnostic).toMatchObject({ effect: 'not_started', code: 'invalid_parameters' });
    const timeline = managementCalls(f.project, { id: failed.task.id });
    expect(timeline.items.filter(row => row.phase === 'finished')[0].diagnostic.original_failure).toEqual(first.diagnostic.original_failure);
    const beforeEvents = f.store.get('SELECT count(*) AS n FROM events').n;
    await expect(f.dispatcher.dispatch('manager.call', { _token: capturedToken, method: 'management.receipt', params: { receipt_id: first.receipt_id } })).rejects.toThrow();
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(beforeEvents);
    expect(() => managementReceipt(other.project, { receipt_id: first.receipt_id })).toThrow('not found');
    for (const actor of [failed.task.id, reader.task.id]) expect(() => assertAllowed('management.receipt', { receipt_id: first.receipt_id }, actor)).toThrow('user approval');
    for (const value of [first, duplicate, isolated, timeline, reader.replies]) { noPrivate(value); expect(JSON.stringify(value)).not.toContain(capturedToken); }
    noPrivate(f.store.all("SELECT data FROM events WHERE type LIKE 'management.call_%' OR type='management.capability_failed'"));
    // True cursors, including interleaved duplicate calls and later disposition, with no skipped related Events.
    let after = 0, items = [];
    for (;;) {
      const page = managementReceipt(f.project, { receipt_id: first.receipt_id, after, limit: 1 });
      items.push(...page.timeline.items); after = page.timeline.next_cursor;
      if (!page.timeline.has_more) break;
      expect(after).toBe(page.timeline.items.at(-1).seq);
    }
    expect(items).toEqual(isolated.timeline.items);
    expect(managementReceipt(f.project, { receipt_id: first.receipt_id, after }).timeline).toMatchObject({ items: [], next_cursor: null, has_more: false });
    expect(executions).toBe(1);
    // Later occurrences can evict private in-memory receipt arrays; the persisted failure remains readable.
    const archived = managementState(f.store.task(failed.task.id)); archived.control_calls = []; archived.last_execution = null;
    f.store.update(failed.task.id, { management: JSON.stringify(archived) });
    expect(managementReceipt(f.project, { receipt_id: first.receipt_id }).diagnostic.original_failure).toEqual(first.diagnostic.original_failure);
  } finally { await other.close(); await f.close(); }
});

for (const failure of ['completion','persistence','completed_event','spoofed_preflight','spoofed_schema']) test(`real bridge ${failure} interruption retains unknown and first error without re-execution`, async () => {
  const f = await harness();
  try {
    const dispatch = f.project.managementDispatch.bind(f.project), update = f.store.update.bind(f.store), event = f.store.event.bind(f.store);
    let effects = 0, injected = false;
    f.project.managementDispatch = async (method, ...args) => {
      const result = await dispatch(method, ...args);
      if (method !== 'draft.add') return result;
      effects++;
      if (failure === 'spoofed_preflight') throw managementScopeError('scope_required'); // A real fixed code at the wrong phase is not pre-execution evidence.
      if (failure === 'spoofed_schema') validateInputEmissionRequest({}); // Likewise, the real schema's -32602 after an effect is not not_started.
      if (failure === 'completion') return Object.defineProperty({}, 'id', { get() { throw new Error('PRIVATE-RETURN-FAILURE'); } });
      return result;
    };
    f.store.update = (id, patch) => {
      if (!injected && failure === 'persistence' && patch.management && JSON.parse(patch.management).control_calls?.some(call => call.status === 'succeeded')) {
        injected = true; throw new Error('PRIVATE-SAVE-FAILURE');
      }
      return update(id, patch);
    };
    f.store.event = (id, type, data) => {
      if (!injected && failure === 'completed_event' && type === 'management.capability_completed') { injected = true; throw new Error('PRIVATE-EVENT-FAILURE'); }
      return event(id, type, data);
    };
    const result = await f.invoke([tool('draft.add', { content: 'PRIVATE-CONTENT' }, 'PRIVATE-KEY'), tool('draft.add', { content: 'PRIVATE-CONTENT' }, 'PRIVATE-KEY')]);
    const receipt = result.replies[0].response.details;
    expect(receipt.status).toBe('unknown'); expect(effects).toBe(1); expect(f.store.draftCount()).toBe(1);
    const code = ['spoofed_preflight','spoofed_schema'].includes(failure) ? 'execution_failed' : failure === 'completion' ? 'completion_failed' : 'persistence_failed';
    const read = managementReceipt(f.project, { receipt_id: receipt.receipt_id });
    expect(read.diagnostic).toMatchObject({ code, effect: 'unknown', original_failure: { code }, retry: 'not_automatic' });
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='management.capability_completed'", result.task.id)).toHaveLength(0);
    f.project.recoverManagementCapabilities(result.task.id);
    expect(managementReceipt(f.project, { receipt_id: receipt.receipt_id }).diagnostic.original_failure).toEqual(read.diagnostic.original_failure);
    noPrivate(read); await isolate(f);
    expect(managementReceipt(f.project, { receipt_id: receipt.receipt_id }).diagnostic.original_failure).toEqual(read.diagnostic.original_failure);
  } finally { await f.close(); }
});

test('failed receipt save cannot erase the first execution failure recorded by the outer trusted call', async () => {
  const f = await harness();
  try {
    const dispatch = f.project.managementDispatch.bind(f.project), update = f.store.update.bind(f.store); let injected = false;
    f.project.managementDispatch = async (method, ...args) => {
      const result = await dispatch(method, ...args);
      if (method === 'draft.add') throw new Error('PRIVATE-ORIGINAL-EXECUTION-FAILURE');
      return result;
    };
    f.store.update = (id, patch) => {
      if (!injected && patch.management && JSON.parse(patch.management).control_calls?.some(call => call.status === 'unknown')) {
        injected = true; throw new Error('PRIVATE-SECONDARY-SAVE-FAILURE');
      }
      return update(id, patch);
    };
    const result = await f.invoke([tool('draft.add', { content: 'PRIVATE-DRAFT' }, 'PRIVATE-KEY')]);
    const error = JSON.parse(result.replies[0].error);
    expect(error.diagnostic).toMatchObject({ code: 'execution_failed', effect: 'unknown', original_failure: { code: 'execution_failed' } });
    const read = managementReceipt(f.project, { receipt_id: error.diagnostic.correlation.receipt_id });
    expect(read).toMatchObject({ status: 'unknown', diagnostic: { original_failure: error.diagnostic.original_failure } });
    const view = f.project.inspect(result.task.id).management;
    expect((view.pending_signal ?? view.last_execution).control_calls[0].diagnostic.original_failure).toEqual(error.diagnostic.original_failure);
    expect(f.store.draftCount()).toBe(1); noPrivate(error); noPrivate(read);
    f.project.recoverManagementCapabilities(result.task.id);
    expect(managementReceipt(f.project, { receipt_id: read.receipt_id }).diagnostic.original_failure).toEqual(error.diagnostic.original_failure);
    await isolate(f);
    expect(managementReceipt(f.project, { receipt_id: read.receipt_id }).diagnostic.original_failure).toEqual(error.diagnostic.original_failure);
  } finally { await f.close(); }
});

test('return/audit interruption is safely locatable; unknown transport does not erase an already-saved effect proof', async () => {
  const f = await harness();
  try {
    const event = f.store.event.bind(f.store); let injected = false;
    f.store.event = (id, type, data) => {
      if (!injected && type === 'management.call_finished') { injected = true; throw new Error('PRIVATE-RETURN-INTERRUPTION'); }
      return event(id, type, data);
    };
    const result = await f.invoke([tool('draft.add', { content: 'PRIVATE-RETURN-DRAFT' }, 'PRIVATE-KEY')]);
    const error = JSON.parse(result.replies[0].error);
    expect(error.diagnostic).toMatchObject({ stage: 'return', code: 'persistence_failed', effect: 'applied' });
    expect(f.store.draftCount()).toBe(1);
    const read = managementReceipt(f.project, { receipt_id: error.diagnostic.correlation.request_event_id });
    expect(read).toMatchObject({ status: 'succeeded', diagnostic: { effect: 'applied', evidence: 'completion_saved' } });
    expect(managementCalls(f.project, { id: result.task.id }).items[0].status).toBe('unknown');
    noPrivate(error); noPrivate(read);
  } finally { await f.close(); }
});

test('real bridge parameter/permission admission, successful read/write and precise confirmation have distinct evidence and locatable request IDs', async () => {
  const f = await harness();
  try {
    set(f, 'worker.transcript_page', 'unavailable'); set(f, 'draft.add', 'confirmation'); set(f, 'manager.query', 'unavailable');
    const result = await f.invoke([tool('worker.list', { scope: 'PRIVATE-BAD-SCOPE' }), tool('worker.transcript_page', { id: 1 }),
      tool('system.summary'), { name: 'manager_query', params: {} }, tool('draft.add', { content: 'PRIVATE-CONFIRMED-DRAFT' }, 'PRIVATE-KEY')]);
    for (const [index, code] of [[0, 'invalid_parameters'], [1, 'permission_denied']]) {
      const error = JSON.parse(result.replies[index].error);
      expect(error.diagnostic).toMatchObject({ code, effect: 'not_started', evidence: 'trusted_pre_dispatch' });
      const read = managementReceipt(f.project, { receipt_id: error.diagnostic.correlation.request_event_id });
      expect(read.diagnostic.code).toBe(code); noPrivate(error);
    }
    expect(result.replies[2].response.details.diagnostic).toMatchObject({ effect: 'not_applicable', evidence: 'read_only' });
    expect(JSON.parse(result.replies[3].error).diagnostic).toMatchObject({ code: 'permission_denied', stage: 'authorization', effect: 'not_started' });
    const pending = result.replies[4].response.details;
    expect(pending).toMatchObject({ status: 'pending_confirmation', diagnostic: { effect: 'not_started', evidence: 'confirmation_pending', original_failure: null } });
    expect(f.store.draftCount()).toBe(0);
    await f.dispatcher.dispatch('notice.answer', { id: pending.notice_id, answer: { answers: [{ selected: [1] }] } });
    // Drain only actual in-process jobs, never a daemon polling loop.
    while (f.project.managementControlJobs?.size) await Promise.all([...f.project.managementControlJobs]);
    const completed = managementReceipt(f.project, { receipt_id: pending.receipt_id });
    expect(completed.diagnostic).toMatchObject({ code: 'succeeded', effect: 'applied', evidence: 'completion_saved', original_failure: null });
    expect(f.store.draftCount()).toBe(1);
    expect(completed.diagnostic.correlation.worker_number).toBe(result.task.worker_number);
    const catalog = managementCatalog(f.project.managementPermissionsSnapshot()).methods.find(item => item.method === 'management.receipt');
    expect(catalog).toMatchObject({ access: 'read', parameters: MANAGEMENT_RECEIPT_PARAMETERS, ...MANAGEMENT_RECEIPT_CAPABILITIES['management.receipt'] });
    const cli = cliCatalog().commands.find(item => item.path === 'lush hooks management receipt');
    expect(cli.rpc[0]).toMatchObject({ method: 'management.receipt', parameters: PARAMS['management.receipt'], schema: catalog.schema });
    // Real public CLI uses the same current-project RPC, not raw files.
    const proc = Bun.spawn([process.execPath, path.resolve(import.meta.dir, '../../bin/lush'), 'hooks', 'management', 'receipt', String(pending.receipt_id), '--limit', '1', '--json'],
      { cwd: f.root, env: env({ ...f.config.env, LUSH_PROJECT: f.root, LUSH_HOME: f.config.home }), stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, err }).toEqual({ code: 0, err: '' }); expect(JSON.parse(out)).toMatchObject({ capability_receipt_id: pending.receipt_id, timeline: { has_more: true } });
    for (const params of [{ receipt_id: String(pending.receipt_id) }, { receipt_id: pending.receipt_id, limit: 101 },
      { receipt_id: pending.receipt_id, after: -1 }, { receipt_id: pending.receipt_id, project: 'PRIVATE' }])
      await expect(f.dispatcher.dispatch('management.receipt', params)).rejects.toThrow();
  } finally { await f.close(); }
});

test('old receipts and event anchors are honest read-only unknown; white-list projection never relays sensitive strings', async () => {
  const f = fixture();
  try {
    f.project.kick = () => {};
    const task = f.project.submitManagementInstruction({ instruction: 'PRIVATE-LEGACY' }).task;
    const receipt = f.store.event(task.id, 'management.capability_requested', { method: 'input.emit', occurrence_id: 1 });
    const state = managementState(f.store.task(task.id));
    state.control_calls = [{ receipt_id: receipt, method: 'input.emit', status: 'unknown', occurrence_id: 1, reason: 'PRIVATE-RAW-ERROR', params: { content: 'PRIVATE-PARAMS' } }];
    f.store.update(task.id, { management: JSON.stringify(state) });
    const before = f.store.task(task.id).management, count = f.store.get('SELECT count(*) AS n FROM events').n;
    const read = managementReceipt(f.project, { receipt_id: receipt });
    expect(read).toMatchObject({ status: 'unknown', diagnostic: { code: 'legacy_unknown', effect: 'unknown', original_failure: null, stage: 'legacy' }, input_emit: { mount: 'unknown', dispatch: 'unknown' } });
    noPrivate(read); expect(f.store.task(task.id).management).toBe(before); expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(count);
    const unsafe = { code: 'PRIVATE-CODE', stage: 'PRIVATE-STAGE', reason: 'PRIVATE-ERROR', params: 'PRIVATE-PARAMS', result: 'PRIVATE-RESULT', request_id: 'PRIVATE-REQUEST',
      correlation: { worker_number: 'PRIVATE-V', actor_id: 'PRIVATE-ID', token: 'PRIVATE-TOKEN' }, original_failure: { code: 'PRIVATE', reason: 'PRIVATE' } };
    noPrivate(safeManagementDiagnostic(unsafe));
    expect(safeManagementDiagnosticError({ code: MANAGEMENT_DIAGNOSTIC_CODE, message: JSON.stringify({ diagnostic: unsafe }) })).toBeNull();
    const unknown = f.store.event(task.id, 'management.call_started', { method: 'system.summary', run_id: 42 });
    expect(managementReceipt(f.project, { receipt_id: unknown }).diagnostic).toMatchObject({ code: 'completion_not_observed', effect: 'unknown', original_failure: null });
    const end = f.store.event(task.id, 'management.call_finished', { method: 'system.summary', call_id: unknown, status: 'succeeded', params: { env: 'PRIVATE-ENV' }, raw: 'PRIVATE-RAW', result: { error: 'PRIVATE-RESULT' } });
    expect(managementReceipt(f.project, { receipt_id: end })).toMatchObject({ status: 'succeeded', diagnostic: { code: 'legacy_unknown', effect: 'unknown' } });
    noPrivate(managementCalls(f.project, { id: task.id }));
    const ids = [receipt];
    for (let i = 0; i < 120; i++) ids.push(f.store.event(task.id, 'management.capability_failed', { receipt_id: receipt, status: 'unknown', diagnostic: safeManagementDiagnostic(unsafe) }));
    let after = 0, collected = [], sawByteClip = false;
    for (;;) {
      const page = managementReceipt(f.project, { receipt_id: receipt, after, limit: 100 });
      sawByteClip ||= page.timeline.truncated;
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(100000);
      collected.push(...page.timeline.items.map(item => item.seq)); after = page.timeline.next_cursor;
      if (!page.timeline.has_more) break;
      expect(after).toBe(page.timeline.items.at(-1).seq);
    }
    expect(sawByteClip).toBe(true); expect(collected).toEqual(ids);
  } finally { await f.close(); }
});

test('real input.emit mount followed by throw is discoverable by exact saved draft revision, never confused with Worker creation/start', async () => {
  const f = await harness();
  try {
    f.project.scheduleInputEmissions = () => {}; // Isolate the mount from independent background dispatch.
    const draft = await f.project.addBufferedDraft('PRIVATE-INPUT', [], 'main', {});
    const saved = f.store.draft(draft.id);
    const legacy = await f.project.addBufferedDraft('PRIVATE-LEGACY-INPUT', [], 'main', {});
    f.store.run('UPDATE drafts SET revision=NULL WHERE id=?', legacy.id); // Isolated historical compatibility fixture.
    const dispatch = f.project.managementDispatch.bind(f.project);
    f.project.managementDispatch = async (method, ...args) => {
      const result = await dispatch(method, ...args);
      if (method === 'input.emit') throw new Error('PRIVATE-AFTER-MOUNT');
      return result;
    };
    const result = await f.invoke([tool('input.emit', { draft_id: String(saved.id), expected_revision: saved.revision }, 'PRIVATE-INPUT-REQUEST'),
      tool('input.emit', { draft_id: String(legacy.id), expected_revision: null }, 'PRIVATE-LEGACY-REQUEST')]);
    const receipt = result.replies[0].response.details;
    expect(receipt.status).toBe('unknown');
    const read = managementReceipt(f.project, { receipt_id: receipt.receipt_id });
    expect(read.input_emit).toMatchObject({ mount: 'confirmed', draft_id: saved.id, revision: saved.revision,
      source_draft_id: saved.id, dispatch: 'not_started', worker_id: null, input_id: null, worker_started: 'unknown' });
    expect(read.diagnostic).toMatchObject({ effect: 'unknown', original_failure: { code: 'execution_failed' } });
    expect(read.input_emit.mount_event_id).toBeGreaterThan(0);
    expect(managementCalls(f.project, { id: result.task.id }).items.find(item => item.phase === 'finished' && item.receipt_id === receipt.receipt_id).input_emit).toEqual(read.input_emit);
    const legacyRead = managementReceipt(f.project, { receipt_id: result.replies[1].response.details.receipt_id });
    expect(legacyRead.input_emit).toMatchObject({ mount: 'confirmed', draft_id: legacy.id, revision: null, source_draft_id: legacy.id,
      dispatch: 'not_started', worker_id: null, worker_started: 'unknown' });
    noPrivate(legacyRead);
    noPrivate(read);
    // Independently dispatch the already-authorized mount once; a read does not cause this.
    await f.project.drainInputEmissions();
    const delivered = managementReceipt(f.project, { receipt_id: receipt.receipt_id });
    expect(delivered.input_emit).toMatchObject({ mount: 'confirmed', dispatch: 'confirmed', worker_started: 'unknown' });
    expect(delivered.input_emit.worker_id).toBeGreaterThan(0); expect(delivered.input_emit.input_id).toBeGreaterThan(0);
    expect(delivered.input_emit.worker_number).toBe(f.store.task(delivered.input_emit.worker_id).worker_number);
    expect(delivered.diagnostic.original_failure).toEqual(read.diagnostic.original_failure);
  } finally { await f.close(); }
});

test('real input.emit schema rejection follows the registered validation phase, not merely its -32602 code', async () => {
  const f = await harness();
  try {
    const result = await f.invoke([{ name: 'manager_catalog', params: {} },
      tool('input.emit', { content: 'PRIVATE-INVALID-INPUT', client_request_id: '' }, 'PRIVATE-INVALID-REQUEST')]);
    const schema = result.replies[0].response.details.methods.find(item => item.method === 'input.emit')?.schema;
    expect(schema).toEqual(INPUT_EMIT_SCHEMA);
    const reply = result.replies[1], diagnostic = JSON.parse(reply.error).diagnostic;
    expect(reply.response).toBeUndefined();
    expect(diagnostic).toMatchObject({ code: 'invalid_parameters', stage: 'parameters', effect: 'not_started', evidence: 'trusted_pre_dispatch',
      correlation: { receipt_id: null } });
    const read = managementReceipt(f.project, { receipt_id: diagnostic.correlation.request_event_id });
    expect(read).toMatchObject({ capability_receipt_id: null, input_emit: null, diagnostic: { effect: 'not_started' } });
    expect(managementState(f.store.task(result.task.id)).control_calls).toHaveLength(0);
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='management.capability_requested'", result.task.id)).toHaveLength(0);
    expect(f.store.draftCount()).toBe(0); expect(f.store.all('SELECT id FROM inputs')).toHaveLength(0);
    noPrivate(reply); noPrivate(read);
  } finally { await f.close(); }
});

for (const action of ['start','retry']) for (const outcome of ['waiting','success','unknown','unknown_save'])
  test(`real Provider -> dedicated manager.${action} -> action receipt: ${outcome}, dedup, independent disposition and no replay`, async () => {
    const f = await harness();
    try {
      const unknown = outcome.startsWith('unknown');
      const target = (await f.project.order('PRIVATE-ACTION-TARGET', 'main', [], null, false)).task;
      if (action === 'retry') f.store.update(target.id, { status: 'failed' });
      if (outcome === 'waiting') f.project.workspaces.busy.add(target.id);
      const name = action === 'start' ? 'resumeTask' : 'retry', execute = f.project[name].bind(f.project); let executions = 0;
      const event = f.store.event.bind(f.store); let saveFailed = false;
      f.store.event = (id, type, data) => {
        if (outcome === 'unknown_save' && !saveFailed && type === 'management.action_completed') {
          saveFailed = true; throw new Error('PRIVATE-ACTION-SAVE-ERROR');
        }
        return event(id, type, data);
      };
      f.project[name] = (...args) => {
        executions++; const value = execute(...args);
        if (outcome === 'unknown') throw new Error('PRIVATE-ACTION-EXECUTION-ERROR');
        return value;
      };
      const result = await f.invoke([actionTool(action, target.id), actionTool(action, target.id)]);
      const first = result.replies[0].response.details;
      expect(first).toMatchObject({ status: outcome === 'waiting' ? 'waiting' : outcome === 'success' ? 'succeeded' : 'unknown',
        diagnostic: { effect: outcome === 'waiting' ? 'not_started' : outcome === 'success' ? 'applied' : 'unknown' } });
      expect(first.diagnostic.code).not.toBe('read_completed');
      expect(first.diagnostic.correlation).toMatchObject({ actor_id: result.task.id, worker_number: result.task.worker_number,
        target_id: target.id, target_worker_number: target.worker_number, receipt_id: first.receipt_id });
      for (const key of ['run_id','call_id','occurrence_id','request_event_id']) expect(first.diagnostic.correlation[key]).toBeGreaterThan(0);
      const read = await f.dispatcher.dispatch('management.receipt', { receipt_id: first.receipt_id, limit: 100 });
      expect(read).toMatchObject({ capability_receipt_id: null, action_receipt_id: first.receipt_id,
        method: action === 'start' ? 'worker.resume' : 'worker.retry', diagnostic: { effect: first.diagnostic.effect },
        action: { receipt_id: first.receipt_id, diagnostic: { effect: first.diagnostic.effect } } });
      expect(read.timeline.items.map(item => item.type)).toContain('management.action_submitted');
      const byCall = managementReceipt(f.project, { receipt_id: first.diagnostic.correlation.call_id });
      expect(byCall.action_receipt_id).toBe(first.receipt_id);
      const view = f.project.inspect(result.task.id).management;
      expect((view.pending_signal ?? view.last_execution).actions[0].diagnostic.effect).toBe(first.diagnostic.effect);
      if (!unknown) {
        expect(result.replies[1].response.details.receipt_id).toBe(first.receipt_id);
        expect(result.replies[1].response.details.diagnostic.correlation.call_id).not.toBe(first.diagnostic.correlation.call_id);
        const ends = managementCalls(f.project, { id: result.task.id }).items.filter(item => item.phase === 'finished');
        expect(ends).toHaveLength(2);
        for (const end of ends) expect(end.diagnostic.correlation.call_id).toBe(end.call_id);
      } else {
        expect(read.diagnostic.original_failure).toMatchObject({ stage: outcome === 'unknown_save' ? 'persistence' : 'execution',
          code: outcome === 'unknown_save' ? 'persistence_failed' : 'execution_failed', effect: 'unknown' });
        expect(read.timeline.items.map(item => item.type)).toContain('management.action_failed');
        f.project.executeManagementAction(result.task.id, first.receipt_id);
        f.project.recoverManagementWorkers();
        await isolate(f);
        const isolated = managementReceipt(f.project, { receipt_id: first.receipt_id });
        expect(isolated.diagnostic.original_failure).toEqual(read.diagnostic.original_failure);
        expect(isolated.diagnostic.disposition).toMatchObject({ worker_status: 'cancelled', emergency: 'isolated' });
      }
      if (outcome === 'waiting') {
        expect(executions).toBe(0);
        expect(read.diagnostic).toMatchObject({ effect: 'not_started', evidence: 'approval_pending' });
        f.project.workspaces.busy.delete(target.id); f.project.drainManagementActions();
        const completed = managementReceipt(f.project, { receipt_id: first.receipt_id });
        expect(completed.diagnostic).toMatchObject({ code: 'succeeded', effect: 'applied', evidence: 'completion_saved' });
        expect(completed.timeline.items.map(item => item.type)).toContain('management.action_completed');
      }
      f.project.drainManagementActions();
      expect(executions).toBe(1);
      if (!unknown) expect(f.store.get('SELECT count(*) AS n FROM agent_runs WHERE task_id=?', target.id).n).toBe(0); // Submission is not Provider start.
      const archived = managementState(f.store.task(result.task.id)); archived.receipts = [];
      if (archived.last_execution) archived.last_execution.actions = [];
      f.store.update(result.task.id, { management: JSON.stringify(archived) });
      const fromEvents = managementReceipt(f.project, { receipt_id: first.receipt_id });
      expect(fromEvents.diagnostic.effect).toBe(unknown ? 'unknown' : 'applied');
      if (unknown) expect(fromEvents.diagnostic.original_failure).toEqual(read.diagnostic.original_failure);
      noPrivate(first); noPrivate(read);
    } finally { f.project.workspaces.busy.clear(); await f.close(); }
  });

for (const action of ['start','retry']) test(`dedicated manager.${action} exact confirmation links capability and delayed action without claiming target completion`, async () => {
  const f = await harness();
  try {
    const target = (await f.project.order('PRIVATE-CONFIRMED-TARGET', 'main', [], null, false)).task;
    if (action === 'retry') f.store.update(target.id, { status: 'failed' });
    f.project.workspaces.busy.add(target.id);
    set(f, action === 'start' ? 'worker.resume' : 'worker.retry', 'confirmation');
    const result = await f.invoke([actionTool(action, target.id)]), pending = result.replies[0].response.details;
    expect(pending).toMatchObject({ status: 'pending_confirmation', diagnostic: { effect: 'not_started', evidence: 'confirmation_pending' } });
    expect(managementState(f.store.task(result.task.id)).receipts).toHaveLength(0);
    await f.dispatcher.dispatch('notice.answer', { id: pending.notice_id, answer: { answers: [{ selected: [1] }] } });
    while (f.project.managementControlJobs?.size) await Promise.all([...f.project.managementControlJobs]);
    const submitted = managementReceipt(f.project, { receipt_id: pending.receipt_id });
    expect(submitted).toMatchObject({ status: 'succeeded', capability_receipt_id: pending.receipt_id,
      diagnostic: { effect: 'applied' }, action: { status: 'waiting', diagnostic: { effect: 'not_started' } } });
    expect(submitted.action_receipt_id).toBeGreaterThan(0);
    const actionRead = managementReceipt(f.project, { receipt_id: submitted.action_receipt_id });
    expect(actionRead.capability_receipt_id).toBe(pending.receipt_id);
    expect(actionRead.diagnostic.correlation.call_id).toBe(pending.diagnostic.correlation.call_id);
    expect(actionRead.diagnostic.correlation.run_id).toBe(pending.diagnostic.correlation.run_id);
    f.project.workspaces.busy.delete(target.id); f.project.drainManagementActions();
    expect(managementReceipt(f.project, { receipt_id: submitted.action_receipt_id }).diagnostic)
      .toMatchObject({ code: 'succeeded', effect: 'applied', evidence: 'completion_saved' });
    const again = managementReceipt(f.project, { receipt_id: pending.receipt_id });
    expect(again.action).toMatchObject({ status: 'succeeded', diagnostic: { effect: 'applied' } });
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='management.action_submitted'", result.task.id)).toHaveLength(1);
    noPrivate(again);
  } finally { f.project.workspaces.busy.clear(); await f.close(); }
});

test('legacy action anchors remain read-only unknown and request-only observations distinguish actual read-only completion from missing proof', async () => {
  const f = fixture();
  try {
    f.project.kick = () => {};
    const task = f.project.submitManagementInstruction({ instruction: 'PRIVATE-LEGACY-ACTION' }).task;
    const target = f.store.create({ role: 'agent', task_kind: 'order', goal: 'PRIVATE-TARGET' });
    const receipt = f.store.event(task.id, 'management.action_submitted', { action: 'start', target_id: target.id, occurrence_id: 1 });
    const state = managementState(f.store.task(task.id));
    state.receipts = [{ receipt_id: receipt, action: 'start', target_id: target.id, occurrence_id: 1, status: 'succeeded', reason: 'PRIVATE-OLD-ERROR' }];
    f.store.update(task.id, { management: JSON.stringify(state) });
    const before = f.store.task(task.id).management, count = f.store.get('SELECT count(*) AS n FROM events').n;
    expect(managementReceipt(f.project, { receipt_id: receipt })).toMatchObject({ status: 'succeeded', action_receipt_id: receipt,
      diagnostic: { code: 'legacy_unknown', effect: 'unknown', original_failure: null } });
    noPrivate(f.project.inspect(task.id).management);
    expect(f.store.task(task.id).management).toBe(before); expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(count);
    const readStart = beginManagementCall(f.project, f.store.task(task.id), 'manager.query', 'manager.query', {});
    finishManagementCall(f.project, task.id, readStart, {}, null);
    expect(managementReceipt(f.project, { receipt_id: readStart.call_id }).diagnostic)
      .toMatchObject({ code: 'read_completed', effect: 'not_applicable', evidence: 'read_only' });
    const unproven = beginManagementCall(f.project, f.store.task(task.id), 'manager.start', 'worker.resume', { id: target.id });
    expect(managementReceipt(f.project, { receipt_id: unproven.call_id }).diagnostic)
      .toMatchObject({ code: 'completion_not_observed', effect: 'unknown' });
    finishManagementCall(f.project, task.id, unproven, { status: 'waiting' }, null);
    expect(managementReceipt(f.project, { receipt_id: unproven.call_id }).diagnostic)
      .toMatchObject({ code: 'request_returned', effect: 'unknown', evidence: 'completion_not_observed' });
  } finally { await f.close(); }
});
