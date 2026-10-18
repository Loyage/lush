import { test, expect } from 'bun:test';
import { fixture, repo } from '../helpers.js';

async function setup() {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  const task = (await f.project.createWorker({ mode: 'spawn' })).task;
  const draft = await f.project.addBufferedDraft('first instruction', [], 'main', { mode: 'append', target_id: task.id });
  await f.project.emitBufferedInput({ draft_id: draft.id, expected_revision: draft.revision, client_request_id: 'first-source' });
  await f.project.drainInputEmissions();
  const receipt = f.project.inputEmissionResult(draft.id).dispatch;
  expect(receipt.state).toBe('succeeded');
  return { ...f, task, draft, receipt, input: receipt.input_id };
}
function source(f) {
  const detail = f.project.inputGet('input', f.input);
  const row = f.project.inputHistory().items.find(row => row.kind === 'input' && row.id === f.input);
  expect(row.source_draft_id).toBe(detail.source_draft_id);
  return detail.source_draft_id;
}
function mutation(f, apply, assertion) {
  f.store.run('SAVEPOINT first_input_source');
  try { apply(); assertion(); }
  finally { f.store.run('ROLLBACK TO first_input_source'); f.store.run('RELEASE first_input_source'); }
}

test('append-first draft -> real Input/O -> original successful dispatch remains a unique explicit source, including repeated emission', async () => {
  const f = await setup();
  try {
    expect(source(f)).toBe(f.draft.id); expect(f.draft.draft_number).toBe(1);
    expect(f.project.inputGet('input', f.input).draft_number).toBeNull();
    expect(f.project.inputEmissionResult(f.draft.id).draft_number).toBe(1);
    expect(f.project.inputGet('draft', f.draft.id)).toMatchObject({ draft_number: 1, mode: 'append', target_id: f.task.id,
      dispatch: { state: 'succeeded', input_id: f.input, worker_id: f.task.id } });
    await f.project.emitBufferedInput({ draft_id: f.draft.id, expected_revision: f.draft.revision, client_request_id: 'first-source' });
    expect(source(f)).toBe(f.draft.id);
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(1);
    expect(f.store.all('SELECT * FROM messages')).toHaveLength(0);
  } finally { await f.close(); }
});

test('append-first source rejects missing/wrong/type-invalid receipt identities, malformed metadata and inconsistent current ownership', async () => {
  const f = await setup();
  try {
    const saved = f.store.draft(f.draft.id), options = JSON.parse(saved.input_options), emission = JSON.parse(saved.emission);
    const patch = (column, value) => f.store.run(`UPDATE drafts SET ${column}=? WHERE id=?`, typeof value === 'string' ? value : JSON.stringify(value), f.draft.id);
    const cases = [
      () => patch('input_options', { ...options, target_id: String(f.task.id) }),
      () => patch('input_options', { ...options, target_id: f.task.parent_id }),
      () => patch('input_options', { ...options, target_id: null }),
      () => patch('input_options', { ...options, mode: 'order' }), // cannot masquerade as the legacy order association
      () => patch('input_options', '[]'),
      () => patch('input_options', JSON.stringify({ mode: 'append', target_id: f.task.id }).replace(`:${f.task.id}`, `:${f.task.id}.0`)),
      () => patch('emission', { ...emission, state: 'queued' }),
      () => patch('emission', { ...emission, input_id: String(f.input) }),
      () => patch('emission', { ...emission, input_id: f.input + 100 }),
      () => patch('emission', { ...emission, worker_id: String(f.task.id) }),
      () => patch('emission', { ...emission, worker_id: f.task.parent_id }),
      () => patch('emission', { ...emission, dispatch_id: 12 }),
      () => patch('emission', { ...emission, dispatch_id: 'not-the-successful-dispatch' }),
      () => patch('emission', { ...emission, message_id: null }),
      () => patch('emission', { ...emission, append_number: 'A-fake' }),
      () => patch('emission', '[]'),
      () => f.store.run('UPDATE drafts SET input_id=NULL WHERE id=?', f.draft.id),
      () => f.store.run('UPDATE drafts SET parent_id=? WHERE id=?', f.task.id, f.draft.id),
      () => f.store.run('UPDATE inputs SET task_id=? WHERE id=?', f.task.parent_id, f.input),
      () => f.store.run('UPDATE tasks SET input_id=NULL WHERE id=?', f.task.id),
      () => f.store.run('UPDATE tasks SET creation=? WHERE id=?', '{malformed', f.task.id),
      () => f.store.run("DELETE FROM events WHERE type='input.dispatch_succeeded'"),
      () => f.store.run("DELETE FROM events WHERE task_id=? AND type='task.first_input'", f.task.id),
      () => f.store.run("UPDATE events SET data=json_set(data,'$.worker_id',?) WHERE type='input.dispatch_succeeded'", f.task.parent_id),
      () => f.store.run("UPDATE events SET data=json_set(data,'$.input_id',?) WHERE type='input.dispatch_succeeded'", String(f.input)),
      () => f.store.run("UPDATE events SET data=json_set(data,'$.message_id',1) WHERE type='input.dispatch_succeeded'"),
      () => f.store.run("UPDATE events SET data=json_set(data,'$.input_id',?) WHERE type='task.first_input'", String(f.input)),
      () => f.store.run("UPDATE events SET data=json_set(data,'$.authorized_by','system') WHERE type='task.first_input'"),
    ];
    for (const change of cases) mutation(f, change, () => expect(source(f)).toBeNull());
    expect(source(f)).toBe(f.draft.id);
  } finally { await f.close(); }
});

test('unproved cloned drafts cannot claim the Input, while two independently proven candidates are ambiguous instead of chosen by order/body', async () => {
  const f = await setup();
  try {
    const saved = f.store.draft(f.draft.id);
    const clone = f.store.addDraft('different body, not evidence');
    f.store.run('UPDATE drafts SET input_id=?,parent_id=?,revision=?,input_options=?,emission=? WHERE id=?',
      f.input, saved.parent_id, saved.revision, saved.input_options, saved.emission, clone.id);
    expect(source(f)).toBe(f.draft.id); // no exact dispatch for clone.id
    const event = JSON.parse(f.store.get("SELECT data FROM events WHERE type='input.dispatch_succeeded' AND task_id=?", saved.parent_id).data);
    f.store.event(saved.parent_id, 'input.dispatch_succeeded', { ...event, draft_id: clone.id });
    expect(source(f)).toBeNull();
  } finally { await f.close(); }
});

test('direct first user message has no draft source and cannot acquire one from a forged emission without a dispatch receipt', async () => {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  try {
    const task = (await f.project.createWorker({ mode: 'spawn' })).task;
    const input = f.project.message(task.id, 'first direct instruction').input_id;
    const draft = f.store.addDraft('same or different text does not prove origin');
    f.store.run('UPDATE drafts SET input_id=?,parent_id=?,input_options=?,emission=? WHERE id=?', input, task.parent_id,
      JSON.stringify({ mode: 'append', target_id: task.id }),
      JSON.stringify({ state: 'succeeded', input_id: input, worker_id: task.id, dispatch_id: 'fabricated' }), draft.id);
    expect(f.project.inputGet('input', input).source_draft_id).toBeNull();
  } finally { await f.close(); }
});
