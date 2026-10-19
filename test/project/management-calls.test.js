import { test, expect } from 'bun:test';
import { fixture, repo } from '../helpers.js';
import { setup, fetch } from '../web/harness.js';
import { managementLegacyRPCProvider as managementToolCLI } from '../agent/management-legacy-rpc-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { beginManagementCall, finishManagementCall, managementCalls } from '../../src/core/project/management-calls.js';
import { assertAllowed } from '../../src/rpc/registry.js';
import { managementPolicy } from '../../src/rpc/management-policy.js';

const eventRows = (f, id) => f.store.all("SELECT id,type,data FROM events WHERE task_id=? AND type IN ('management.call_started','management.call_finished') ORDER BY id", id);

test('real Provider/tools/bridge/RPC audits reads, deduplicated writes, denied/invalid requests and serves safe user-only HTTP pages', async () => {
  const f = await setup();
  try {
    f.project.kick = () => {};
    await repo(f.root);
    const target = (await f.project.order('PRIVATE-TARGET-GOAL', 'main', [], null, false)).task;
    const cli = managementToolCLI(f.root, 'node', { compactCatalog: true });
    f.config.env.LUSH_PI_COMMAND = cli.command;
    const provider = new AgentProvider(f.config, f.project.agentSettings);
    const dispatcher = f.project.rpcDispatcher;
    let token;
    const run = provider.run.bind(provider);
    provider.run = async options => {
      token = options.token;
      // Runtime-issued, currently active credential: malformed outer transport
      // params never execute, but are recorded after real identity verification.
      await expect(dispatcher.dispatch('manager.query', { _token: token, arbitrary: 'PRIVATE-EXTRA' })).rejects.toThrow('invalid_parameters');
      await expect(dispatcher.dispatch('worker.management_calls', { _token: token, id: options.task.id })).rejects.toThrow();
      // Real concurrent Dispatcher execution, using the runtime identity. inspect
      // awaits actual Git/resource reads while the safe query can return first.
      await Promise.all([
        dispatcher.dispatch('manager.call', { _token: token, method: 'worker.inspect', params: { id: target.id } }),
        dispatcher.dispatch('manager.query', { _token: token, id: target.id }),
      ]);
      // The parent's user CLI correlation remains private across audit wrapping.
      // Even a real manager token cannot turn it into a user CLI identity.
      await expect(dispatcher.dispatch('manager.query', { _token: token, _cli_trial: 'a'.repeat(64) }))
        .rejects.toThrow('preflight_rejected');
      return run(options);
    };
    f.project.provider = provider;
    const manager = f.project.submitManagementInstruction({ instruction: 'PRIVATE-INSTRUCTION', profile: { agent: 'pi', config_mode: 'pi' } }).task;
    const draft = { name: 'manager_call', callId: 'PRIVATE-REQUEST-ID', params: { method: 'draft.add', params: { content: 'PRIVATE-DRAFT-CONTENT', branch: 'main' } } };
    cli.plan([
      { name: 'manager_catalog', params: {} },
      { name: 'manager_query', params: { worker: target.worker_number } },
      draft, draft,
      { name: 'manager_call', params: { method: 'worker.transcript_page', params: { id: target.id } } },
      { name: 'manager_call', params: { method: 'worker.list', params: { scope: 'PRIVATE-SCOPE' } } },
      { name: 'manager_call', params: { method: 'PRIVATE-UNKNOWN-METHOD', params: {} } },
      { name: 'manager_call', params: { method: 'worker.management_calls', params: { id: manager.id } } },
      { name: 'manager_start', params: { worker: target.id } },
    ]);
    f.project.pump();
    await Promise.all([...f.project.running.values()].map(run => run.promise));
    expect(f.store.task(manager.id).status).toBe('completed');
    expect(f.store.draftCount()).toBe(1);
    expect((await fetch(f.url + `/api/worker/${manager.id}/management-calls`, { anonymous: true })).status).toBe(401);
    const response = await fetch(f.url + `/api/worker/${manager.id}/management-calls`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const page = await response.json();
    expect(page).toMatchObject({ has_more: false, coverage: 'trusted_management_rpc_events_only', history_complete: false });
    const starts = page.items.filter(item => item.phase === 'started'), ends = page.items.filter(item => item.phase === 'finished');
    expect(starts).toHaveLength(14); expect(ends).toHaveLength(starts.length);
    expect(ends[0]).toMatchObject({ transport_method: 'manager.query', status: 'rejected', reason: 'invalid_parameters', params: {} });
    for (const end of ends) {
      const start = starts.find(item => item.call_id === end.call_id);
      expect(end).toMatchObject({ method: start.method, params: start.params, run_id: start.run_id,
        occurrence_id: start.occurrence_id, started_at: start.started_at });
      expect(end.run_id).toBeGreaterThan(0); expect(end.occurrence_id).toBeGreaterThan(0);
      expect(end.duration_ms).toBeGreaterThanOrEqual(0);
      expect(Date.parse(end.finished_at)).toBeGreaterThanOrEqual(Date.parse(end.started_at));
    }
    const concurrent = page.items.slice(2, 6);
    expect(concurrent.map(item => item.phase)).toEqual(['started','started','finished','finished']);
    expect(concurrent[2].call_id).toBe(concurrent[1].call_id);
    expect(concurrent[3].call_id).toBe(concurrent[0].call_id);
    const writes = ends.filter(item => item.method === 'draft.add');
    expect(writes).toHaveLength(2);
    expect(writes[0].call_id).not.toBe(writes[1].call_id);
    expect(writes[0].receipt_id).toBe(writes[1].receipt_id);
    expect(writes[0]).toMatchObject({ status: 'succeeded', params: {}, result: { status: 'succeeded' } });
    expect(ends.find(item => item.method === 'worker.lookup')).toMatchObject({ target_id: target.id, target_worker_number: target.worker_number, params: {} });
    expect(ends.find(item => item.method === null)).toMatchObject({ transport_method: 'manager.call', status: 'failed' });
    for (const method of ['worker.transcript_page','worker.list','worker.management_calls'])
      expect(ends.find(item => item.method === method)).toMatchObject({ status: 'failed', reason: 'request_failed_or_denied' });
    expect(ends.at(-1)).toMatchObject({ method: 'worker.resume', transport_method: 'manager.start', status: 'succeeded',
      target_id: target.id, result: { status: 'succeeded' } });
    const publicEvents = JSON.stringify(eventRows(f, manager.id));
    expect(publicEvents).not.toContain('PRIVATE-'); expect(publicEvents).not.toContain(token);
    expect(publicEvents).not.toContain('_token');
    expect(publicEvents).not.toContain('_cli_trial');
    expect(publicEvents).not.toContain('a'.repeat(64));
    // Expired credentials cannot create trusted audit records or execute replayed calls.
    const count = eventRows(f, manager.id).length;
    await expect(dispatcher.dispatch('manager.query', { _token: token })).rejects.toThrow();
    await expect(dispatcher.dispatch('manager.query', { _token: token, arbitrary: true })).rejects.toThrow();
    expect(eventRows(f, manager.id)).toHaveLength(count);
    // Real HTTP validates at both adapter and RPC boundaries, not by coercion.
    for (const suffix of ['?limit=0','?limit=101','?limit=1.5','?limit=01','?limit=','?after=-1','?after=1&before=2',
      '?after=0&after=1','?id=1','?before=0','?limit=9007199254740992'])
      expect((await fetch(f.url + `/api/worker/${manager.id}/management-calls${suffix}`)).status).toBe(400);
    expect((await fetch(f.url + `/api/worker/${target.id}/management-calls`)).status).toBe(400);
    expect((await fetch(f.url + '/api/worker/999999/management-calls')).status).toBe(400);
    expect(managementPolicy('worker.management_calls').access).toBe('unavailable');
    for (const actor of [manager.id, target.id]) expect(() => assertAllowed('worker.management_calls', { id: manager.id }, actor)).toThrow('requires user approval');
    // Every one-record HTTP page is independently meaningful, with no skips.
    let after = 0, collected = [];
    for (;;) {
      const part = await (await fetch(f.url + `/api/worker/${manager.id}/management-calls?after=${after}&limit=1`)).json();
      expect(part.items).toHaveLength(1);
      collected.push(...part.items);
      expect(part.latest_cursor).toBe(part.items[0].seq); expect(part.next_cursor).toBe(part.latest_cursor);
      after = part.next_cursor;
      if (!part.has_more) break;
    }
    expect(collected).toEqual(page.items);
  } finally { await f.close(); }
});

test('event-ID pagination preserves interleaved starts/finishes, independent snapshots, ownership and unknown interrupted calls', async () => {
  const f = fixture();
  try {
    f.project.kick = () => {};
    const manager = f.store.task(f.project.submitManagementInstruction({ instruction: 'inspect current project' }).task.id);
    const a = beginManagementCall(f.project, manager, 'manager.query', 'manager.query', { limit: 1, arbitrary: 'PRIVATE-ARG' });
    const b = beginManagementCall(f.project, manager, 'manager.history', 'manager.history', { limit: 2 });
    finishManagementCall(f.project, manager.id, b, { arbitrary: 'PRIVATE-OUTPUT', status: 'waiting', action: { receipt_id: 6, status: 'waiting', arbitrary: 'PRIVATE-ACTION' } }, null);
    f.store.event(manager.id, 'unrelated', {});
    finishManagementCall(f.project, manager.id, a, null, new Error('PRIVATE-ERROR'));
    const orphan = beginManagementCall(f.project, manager, 'manager.query', 'manager.query', {});
    // A start from another management identity must not enter this stream.
    const other = f.store.create({ role: 'manager', goal: 'other', task_kind: 'management' });
    beginManagementCall(f.project, other, 'manager.catalog', 'manager.catalog', {});
    const full = managementCalls(f.project, { id: manager.id });
    expect(full.items.map(item => item.call_id)).toEqual([a.call_id, b.call_id, b.call_id, a.call_id, orphan.call_id]);
    expect(full.items.at(-1)).toMatchObject({ phase: 'started', status: 'unknown', reason: 'completion_not_observed' });
    expect(full.items[2]).toMatchObject({ phase: 'finished', method: 'manager.history', params: { limit: 2 },
      status: 'succeeded', result: { status: 'waiting', action: { receipt_id: 6, status: 'waiting' } } });
    expect(JSON.stringify(full)).not.toContain('PRIVATE-');
    let before, backward = [];
    for (;;) {
      const page = managementCalls(f.project, { id: manager.id, limit: 2, ...(before ? { before } : {}) });
      expect(page.items.map(item => item.seq)).toEqual(page.items.map(item => item.seq).sort((a,b) => a-b));
      backward = [...page.items, ...backward]; before = page.next_cursor;
      expect(page.latest_cursor).toBe(page.items.at(-1).seq);
      if (!page.has_more) break;
    }
    expect(backward).toEqual(full.items);
    expect(managementCalls(f.project, { id: manager.id, after: full.latest_cursor })).toMatchObject({ items: [], next_cursor: null, latest_cursor: null, has_more: false });
    for (const params of [{ id: String(manager.id) }, { id: manager.id, limit: '1' }, { id: manager.id, before: null }, { id: manager.id, after: 1.5 }])
      expect(() => managementCalls(f.project, params)).toThrow();
    // Unknown is a read-only observation, not a persisted completion or replay.
    expect(eventRows(f, manager.id)).toHaveLength(5);
  } finally { await f.close(); }
});

test('default tail and maximum windows remain bounded and lost invocation completion is unknown, never replayed', async () => {
  const f = fixture();
  try {
    f.project.kick = () => {};
    const manager = f.store.task(f.project.submitManagementInstruction({ instruction: 'inspect' }).task.id);
    const ids = [];
    for (let i = 0; i < 125; i++) ids.push(beginManagementCall(f.project, manager, 'manager.query', 'manager.query', {}).call_id);
    const tail = managementCalls(f.project, { id: manager.id });
    expect(tail.items).toHaveLength(50); expect(tail.has_more).toBe(true);
    expect(tail.items.map(item => item.seq)).toEqual(ids.slice(-50));
    expect(tail.next_cursor).toBe(ids.at(-50)); expect(tail.latest_cursor).toBe(ids.at(-1));
    const first = managementCalls(f.project, { id: manager.id, after: 0, limit: 100 });
    const last = managementCalls(f.project, { id: manager.id, after: first.next_cursor, limit: 100 });
    expect(first.items).toHaveLength(100); expect(first.has_more).toBe(true);
    expect(last.items).toHaveLength(25); expect(last.has_more).toBe(false);
    expect([...first.items, ...last.items].map(item => item.seq)).toEqual(ids);
    // Controlled live runtime metadata only, not an authentication bypass.
    f.store.update(manager.id, { status: 'running' });
    f.project.running.set(manager.id, { recordId: 4242, controller: new AbortController() });
    const active = beginManagementCall(f.project, f.store.task(manager.id), 'manager.query', 'manager.query', {});
    expect(managementCalls(f.project, { id: manager.id, after: ids.at(-1) }).items[0]).toMatchObject({ call_id: active.call_id, run_id: 4242, status: 'running' });
    f.project.running.delete(manager.id);
    expect(managementCalls(f.project, { id: manager.id, after: ids.at(-1) }).items[0]).toMatchObject({ call_id: active.call_id, run_id: 4242, status: 'unknown' });
    expect(eventRows(f, manager.id)).toHaveLength(126);
  } finally { f.project.running.clear(); await f.close(); }
});
