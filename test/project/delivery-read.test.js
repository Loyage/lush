import { test, expect } from 'bun:test';
import { fixture } from '../helpers.js';
import { decodeReservation } from '../../src/core/project/progress.js';
import { PARAMS, USER_ONLY, INTEGRATION_METHODS, assertAllowed } from '../../src/rpc/registry.js';

const commit = 'a'.repeat(40);
function setup() {
  const f = fixture();
  const parent = f.store.create({ role: 'agent', task_kind: 'main', goal: 'main' });
  f.store.update(parent.id, { status: 'waiting', branch: 'main' });
  return { ...f, parent: f.store.task(parent.id) };
}
function task(f) {
  const row = f.store.create({ role: 'agent', task_kind: 'order', parent_id: f.parent.id, goal: '\\"😀'.repeat(40) });
  f.store.update(row.id, { status: 'waiting', target_branch: 'main', branch: `source-${row.id}` }); return f.store.task(row.id);
}
function batch(f, count = 2) {
  const sources = Array.from({ length: count }, () => task(f));
  const members = sources.map(row => ({ task_id: row.id, delivery_id: row.id + 100, enqueue_seq: row.id + 100,
    source_branch: row.branch, source_commit: commit, base_commit: commit }));
  const run = f.store.createDeliveryRun({ parent_id: f.parent.id, target_branch: 'main', baseline: commit, validation: null,
    data: JSON.stringify({ verification_mode: 'agent', env: 'PRIVATE_ENV', profile: 'PRIVATE_PROFILE' }), members });
  for (const member of members) f.store.update(member.task_id, { reservation: JSON.stringify({ version: 3, kind: 'merge', status: 'requested', parent_id: f.parent.id,
    commit, verification_mode: 'agent', validation: null, delivery_id: member.delivery_id, enqueue_seq: member.enqueue_seq, run_id: run.id, generation: 1 }) });
  return { run, sources, members };
}
function helper(f, run, generation = 1, status = 'queued', key = 'conflict') {
  const row = f.store.create({ role: 'agent', task_kind: 'integration', parent_id: f.parent.id, goal: '\\"😀'.repeat(40) });
  f.store.update(row.id, { status });
  const node = f.store.createDeliveryNode({ run_id: run.id, generation, node_key: key, state: 'resolving', data: '{}', helper_id: row.id });
  return { ...row, node };
}

test('v3 decoding accepts real fixed agent and legacy command requests, rejects unknown and damaged records, v1/v2 unchanged', () => {
  const booking = { version: 3, kind: 'merge', status: 'requested', parent_id: 1, delivery_id: 2, enqueue_seq: 2, commit, verification_mode: 'agent', validation: null };
  for (const status of ['requested','executing','blocked','integrated','suspended','withdrawn']) expect(decodeReservation({ ...booking, status })).toMatchObject({ version: 3, status });
  expect(decodeReservation({ ...booking, verification_mode: undefined, validation: { command_id: 'legacy-command' } })).toMatchObject({ version: 3 });
  for (const patch of [{ version: 4 }, { status: 'unknown' }, { kind: 'showcase' }, { commit: 'oops' }, { delivery_id: 0 },
    { verification_mode: 'unknown' }, { validation: {} }, { run_id: 3 }, { generation: 0, run_id: 1 }]) expect(decodeReservation({ ...booking, ...patch })).toEqual({ status: 'invalid' });
  expect(decodeReservation('{oops')).toEqual({ status: 'invalid' });
  expect(decodeReservation({ version: 2, kind: 'merge', status: 'resolving' })).toEqual({ version: 2, kind: 'merge', status: 'resolving' });
  expect(decodeReservation({ version: 1, kind: 'showcase', status: 'completed' })).toMatchObject({ status: 'completed' });
});

test('batch stages reflect actual helper states, retry generations never reuse stale helper, missing/unknown explicitly visible', async () => {
  const f = setup();
  try {
    const { run, sources } = batch(f), h = helper(f, run);
    f.store.updateDeliveryRun(run.id, { state: 'resolving' });
    const read = () => f.project.workerDeliveryGraph().items[0];
    expect(read().blocked_code).toBe('integration_waiting');
    for (const [status, code] of [['running','integration_running'],['awaiting','integration_decision'],['failed','integration_failed'],['awaiting_acceptance','integration_ready'],['completed','integration_ready']]) {
      f.store.update(h.id, { status }); expect(read().blocked_code).toBe(code); expect(read().stage).toBe('resolving');
      expect(read().sources[0].delivery_summary).toEqual(f.project.taskDeliverySummary(f.store.task(sources[0].id)));
    }
    f.store.updateDeliveryRun(run.id, { state: 'awaiting', data: { verification_mode: 'agent', wait_reason: 'integration_slot' } });
    expect(read().blocked_code).toBe('integration_slot');
    f.store.updateDeliveryRun(run.id, { generation: 2, state: 'ready', data: { verification_mode: 'agent' } });
    expect(read()).toMatchObject({ generation: 2, previous_generation_node_count: 1, integration_workers: { items: [], total: 0 }, blocked_code: 'landing_safety' });
    expect(read().sources[0].delivery_summary).toMatchObject({ current: false, identity_mismatch: true });
    f.store.updateDeliveryRun(run.id, { integration_worker_id: h.id });
    expect(read().integration_workers.items[0]).toMatchObject({ id: h.id, generation: 1, current: false });
    expect(read().blocked_code).toBe('landing_safety');
    f.store.updateDeliveryRun(run.id, { integration_worker_id: null });
    for (const state of ['landing','failed','blocked','stale','withdrawn']) {
      f.store.updateDeliveryRun(run.id, { state, error: 'PRIVATE_STACK_TOKEN' }); expect(read().stage).toBe(state); expect(JSON.stringify(read())).not.toContain('PRIVATE_');
    }
    f.store.updateDeliveryRun(run.id, { state: 'awaiting' }); expect(read().blocked_code).toBe('awaiting');
    const missing = f.store.createDeliveryNode({ run_id: run.id, generation: 2, node_key: 'missing', state: 'resolving', data: '{}' });
    f.store.run('UPDATE delivery_nodes SET helper_id=? WHERE id=?', 999999, missing.id);
    expect(read().integration_workers.items[0]).toMatchObject({ id: 999999, status: null, worker_number: null, missing: true, node_id: missing.id });
    expect(read().nodes[0].locator).toEqual({ run_id: run.id, generation: 2, node_id: missing.id });
  } finally { await f.close(); }
});

test('serial v2 rounds, pending intent and missing v3 batch remain visible; historical receipt is not next-round delivery', async () => {
  const f = setup();
  try {
    const one = task(f), two = task(f), three = task(f);
    f.store.update(one.id, { reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'pending' }) });
    f.store.update(two.id, { reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'resolving', parent_id: f.parent.id, delivery_id: 900, attempt_id: 12, commit }) });
    f.store.update(three.id, { reservation: JSON.stringify({ version: 3, kind: 'merge', status: 'requested', parent_id: f.parent.id, delivery_id: 901, enqueue_seq: 901,
      commit, verification_mode: 'agent', validation: null, run_id: 999, generation: 1 }) });
    const items = f.project.workerDeliveryGraph().items;
    expect(items.find(row => row.key === `intent:${one.id}`)).toMatchObject({ kind: 'intent', blocked_code: 'intent' });
    expect(items.find(row => row.key === `serial:${two.id}:900`)).toMatchObject({ kind: 'serial', blocked_code: 'resolving', sources: [{ delivery_summary: { attempt_id: 12 } }] });
    expect(items.find(row => row.key === `serial:${three.id}:901`)).toMatchObject({ blocked_code: 'missing_batch' });
    const event = f.store.event(two.id, 'task.merge_integrated', { delivery_id: 900, attempt_id: 12, parent_id: f.parent.id, commit, source_commit: commit });
    f.store.update(two.id, { reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'integrated', parent_id: f.parent.id, delivery_id: 900, attempt_id: 12 }) });
    expect(f.project.workerDeliveryGraph({ history: true })).toMatchObject({ matched_total: 1, items: [{ key: `serial:${two.id}:900`, locator: { event_id: event } }] });
    f.store.update(two.id, { reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'pending' }) });
    expect(f.project.workerDeliveryGraph().items.find(row => row.key === `intent:${two.id}`)).toMatchObject({ stage: 'pending' });
    expect(f.project.workerDeliveryGraph({ history: true }).items[0].sources[0].delivery_summary.current).toBe(false);
    f.store.update(one.id, { reservation: '{invalid' });
    expect(f.project.workerDeliveryGraph().items[0]).toMatchObject({ stage: 'invalid', blocked_code: 'invalid_reservation' });
    const oversized = JSON.stringify({ version: 2, kind: 'merge', status: 'pending', legacy_payload: 'x'.repeat(70000) });
    f.store.update(one.id, { reservation: oversized });
    expect(f.project.workerDeliveryGraph().items[0]).toMatchObject({ blocked_code: 'reservation_truncated', sources: [{ delivery_summary: { reservation_truncated: true } }] });
    expect(f.store.task(one.id).reservation).toBe(oversized);
  } finally { await f.close(); }
});

test('historical batch never borrows next-round v2 attempt or invalid reservation, missing sources remain explicitly unknown', async () => {
  const f = setup();
  try {
    const { run, sources, members } = batch(f);
    f.store.updateDeliveryRun(run.id, { state: 'integrated' });
    f.store.releaseDeliveryMembers(run.id);
    f.store.update(sources[0].id, { reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'resolving', delivery_id: 998, attempt_id: 999, parent_id: f.parent.id }) });
    const first = f.project.workerDeliveryGraph({ history: true }).items[0].sources[0].delivery_summary;
    expect(first).toMatchObject({ version: 3, delivery_id: members[0].delivery_id, attempt_id: null, stage: 'integrated', current: false, reservation_status: null, waiting_reason: null });
    f.store.update(sources[0].id, { reservation: '{invalid' });
    expect(f.project.workerDeliveryGraph({ history: true }).items[0].sources[0].delivery_summary.waiting_reason).toBeNull();
    // Retained historical members deliberately have no tasks FK; simulate a deleted legacy source.
    f.store.run('UPDATE delivery_members SET task_id=? WHERE run_id=? AND task_id=?', 999999, run.id, sources[1].id);
    expect(f.project.workerDeliveryGraph({ history: true }).items[0].sources[1]).toMatchObject({ id: 999999, status: null, missing: true,
      delivery_summary: { current: false, input_queue: { buffered: null }, locator: { worker_id: 999999, delivery_id: members[1].delivery_id } } });
    f.store.event(null, 'task.merge_integrated', { parent_id: f.parent.id, delivery_id: 888, source_commit: commit, commit });
    expect(f.project.workerDeliveryGraph({ history: true }).items.find(row => row.kind === 'serial').sources[0]).toMatchObject({
      id: null, parent_id: null, missing: true, delivery_summary: { key: 'delivery:null:888', locator: { worker_id: null } } });
  } finally { await f.close(); }
});

test('full counters independent of paging, cursor filter/project/staleness gates, strict params and no model capability expansion', async () => {
  const f = setup(), other = setup();
  try {
    for (let i = 0; i < 5; i++) batch(f, 2);
    const first = f.project.workerDeliveryGraph({ limit: 2 });
    expect(first).toMatchObject({ matched_total: 5, counts: { active: 5, history: 0, sources_by_stage: { preparing: 10 } }, has_more: true, truncated: true });
    const second = f.project.workerDeliveryGraph({ limit: 3, cursor: first.cursor });
    expect(second.items).toHaveLength(3); expect(second.has_more).toBe(false);
    expect(new Set([...first.items, ...second.items].map(row => row.key)).size).toBe(5);
    for (const params of [{ cursor: first.cursor, history: true }, { cursor: 'bad' }, { limit: '2' }, { limit: 0 }, { limit: 51 }, { history: 1 }])
      expect(() => f.project.workerDeliveryGraph(params)).toThrow();
    expect(() => other.project.workerDeliveryGraph({ cursor: first.cursor })).toThrow();
    f.store.updateDeliveryRun(1, { generation: 2 });
    expect(() => f.project.workerDeliveryGraph({ cursor: first.cursor })).toThrow('Worker delivery graph cursor stale');
    expect(USER_ONLY.has('worker.delivery_graph')).toBe(true); expect(INTEGRATION_METHODS.has('worker.delivery_graph')).toBe(false);
    expect(() => assertAllowed('worker.delivery_graph', { profile: {} }, null)).toThrow('unknown parameter');
    expect(() => assertAllowed('worker.delivery_graph', {}, 8)).toThrow('requires user approval');
    expect(PARAMS['worker.delivery_graph']).toEqual(['history','cursor','limit']);
  } finally { await f.close(); await other.close(); }
});

test('attention is complete across pages and helper limits, deduplicates whole batches and ignores old generations and successful history', async () => {
  const f = setup();
  try {
    const expected = new Set(); let late, lateHelper, old, history, normal;
    f.store.transaction(() => {
      normal = batch(f); helper(f, normal.run, 1, 'queued');
      late = batch(f, 3);
      for (let i = 0; i < 33; i++) lateHelper = helper(f, late.run, 1, i === 32 ? 'awaiting' : 'queued', `late-${i}`);
      expected.add(`batch:${late.run.id}`);
      const multiple = batch(f, 4);
      helper(f, multiple.run, 1, 'failed', 'failed'); helper(f, multiple.run, 1, 'paused', 'paused');
      helper(f, multiple.run, 1, 'cancelled', 'cancelled'); expected.add(`batch:${multiple.run.id}`);
      old = batch(f); const prior = helper(f, old.run, 1, 'awaiting');
      f.store.updateDeliveryRun(old.run.id, { generation: 2, integration_worker_id: prior.id });
      history = batch(f); helper(f, history.run, 1, 'awaiting'); f.store.updateDeliveryRun(history.run.id, { state: 'integrated' });
      for (const damage of ['missing','type','parent','null_helper','unbound']) {
        const item = batch(f), h = helper(f, item.run);
        if (damage === 'missing') f.store.run('UPDATE delivery_nodes SET helper_id=? WHERE id=?', 999999, h.node.id);
        if (damage === 'type') f.store.run("UPDATE tasks SET task_kind='order' WHERE id=?", h.id);
        if (damage === 'parent') f.store.run('UPDATE tasks SET parent_id=NULL WHERE id=?', h.id);
        if (damage === 'null_helper') f.store.run('UPDATE delivery_nodes SET helper_id=NULL WHERE id=?', h.node.id);
        if (damage === 'unbound') f.store.run('UPDATE delivery_runs SET integration_worker_id=? WHERE id=?', 999999, item.run.id);
        expected.add(`batch:${item.run.id}`);
      }
      for (const state of ['failed','blocked','awaiting','stale']) {
        const item = batch(f); f.store.updateDeliveryRun(item.run.id, { state }); expected.add(`batch:${item.run.id}`);
      }
      const invalid = task(f); f.store.update(invalid.id, { reservation: '{invalid' }); expected.add(`intent:${invalid.id}`);
    });
    const snapshot = () => JSON.stringify(Object.fromEntries(['tasks','events','delivery_runs','delivery_nodes','delivery_members','messages','notices','meta']
      .map(table => [table, f.store.all(`SELECT * FROM ${table} ORDER BY rowid`)])));
    const before = snapshot(), all = []; let cursor;
    do {
      const page = f.project.workerDeliveryGraph({ limit: 2, ...(cursor ? { cursor } : {}) });
      expect(page.counts.attention).toBe(expected.size);
      all.push(...page.items); cursor = page.cursor;
    } while (cursor);
    expect(new Set(all.filter(item => item.attention).map(item => item.key))).toEqual(expected);
    expect(all.slice(0, expected.size).every(item => item.attention)).toBe(true);
    expect(all.slice(expected.size).every(item => !item.attention)).toBe(true);
    for (const item of all) for (const src of item.sources ?? []) expect(src.delivery_summary.attention).toBe(item.attention);
    const outOfBounds = all.find(item => item.run_id === late.run.id);
    expect(outOfBounds).toMatchObject({ attention: true, blocked_code: 'integration_decision', integration_workers: { total: 33, truncated: true } });
    expect(outOfBounds.integration_workers.items.every(item => item.status === 'queued')).toBe(true);
    expect(f.project.taskDeliverySummary(f.store.task(late.sources[0].id))).toMatchObject({ attention: true, blocked_code: 'integration_decision' });
    expect(all.find(item => item.run_id === old.run.id)).toMatchObject({ attention: false, integration_workers: { items: [{ current: false, status: 'awaiting' }] } });
    const historyPage = f.project.workerDeliveryGraph({ history: true, limit: 1 });
    expect(historyPage).toMatchObject({ counts: { attention: expected.size }, items: [{ run_id: history.run.id, attention: false, sources: [{ delivery_summary: { attention: false } }, { delivery_summary: { attention: false } }] }] });
    expect(snapshot()).toBe(before);
    const first = f.project.workerDeliveryGraph({ limit: 1 });
    f.store.update(lateHelper.id, { status: 'awaiting_acceptance' });
    expect(f.project.workerDeliveryGraph({ limit: 1 }).counts.attention).toBe(expected.size - 1);
    expect(() => f.project.workerDeliveryGraph({ cursor: first.cursor })).toThrow('Worker delivery graph cursor stale');
    expect(f.project.taskDeliverySummary(f.store.task(late.sources[0].id)).attention).toBe(false);
    expect(f.project.workerDeliveryGraph({ history: true }).counts.attention).toBe(expected.size - 1);
  } finally { await f.close(); }
});

test('attention follows real current helper lifecycle without counting ready handoffs or merging identities', async () => {
  const f = setup();
  try {
    const { run } = batch(f), h = helper(f, run);
    f.store.updateDeliveryRun(run.id, { state: 'resolving' });
    for (const [status, attention] of [['queued',false],['running',false],['awaiting',true],['paused',true],['failed',true],['cancelled',true],['awaiting_acceptance',false],['completed',false]]) {
      f.store.update(h.id, { status });
      expect(f.project.workerDeliveryGraph()).toMatchObject({ counts: { attention: Number(attention) }, items: [{ attention, stage: 'resolving' }] });
    }
    f.store.updateDeliveryRun(run.id, { state: 'integrated' }); f.store.update(h.id, { status: 'failed' });
    expect(f.project.workerDeliveryGraph({ history: true })).toMatchObject({ counts: { attention: 0 }, items: [{ attention: false }] });
  } finally { await f.close(); }
});

test('serialized byte bound actually paginates large escaped multi-source batches, retains helper/node truncation and advances', async () => {
  const f = setup();
  try {
    f.store.transaction(() => {
      for (let i = 0; i < 14; i++) {
        const { run } = batch(f, 8);
        for (let j = 0; j < 34; j++) helper(f, run, 1, 'queued', `node-${j}`);
      }
    });
    const before = f.store.get('SELECT count(*) AS n FROM events').n;
    const first = f.project.workerDeliveryGraph({ limit: 50 });
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(900000);
    expect(first.items.length).toBeGreaterThan(0); expect(first.items.length).toBeLessThan(14);
    expect(first).toMatchObject({ has_more: true, counts: { active: 14, sources_by_stage: { preparing: 112 } } });
    expect(first.items[0]).toMatchObject({ nodes_truncated: true, node_count: 34, integration_workers: { total: 34, truncated: true } });
    const next = f.project.workerDeliveryGraph({ limit: 50, cursor: first.cursor });
    expect(next.items[0].key).not.toBe(first.items[0].key);
    expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThan(900000);
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(before);
  } finally { await f.close(); }
});
