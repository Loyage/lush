import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fixture, repo, until } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { tokenHash } from '../../src/core/project/internal.js';
import { PARAMS } from '../../src/rpc/registry.js';
import { INPUT_EMIT_CAPABILITY, INPUT_EMIT_SCHEMA, INPUT_EMIT_PARAMS, validateInputEmissionRequest as validate } from '../../src/core/input-emission-protocol.js';
import { normalizeAgentProfile } from '../../src/agent/settings.js';
import referenceProtocol from '../../src/core/project/references.js';
import { managementCatalog, validateManagementCall, managementPolicy } from '../../src/rpc/management-policy.js';
import { cliCatalog } from '../../src/rpc/cli-catalog.js';

const reference = { kind: 'text', label: 'saved quote', quote: 'original selection' };
async function setup(provider) {
  const f = fixture(provider); f.project.stopping = true; await repo(f.root);
  f.rpc = new Dispatcher(f.project);
  f.emit = params => f.rpc.dispatch('input.emit', params);
  return f;
}

test('Node-loadable capability is the unchanged schema/runtime source, with discoverable parameters and examples', () => {
  expect(INPUT_EMIT_CAPABILITY.schema).toBe(INPUT_EMIT_SCHEMA);
  expect(INPUT_EMIT_PARAMS).toEqual(Object.keys(INPUT_EMIT_SCHEMA.properties));
  expect(PARAMS['input.emit']).toBe(INPUT_EMIT_PARAMS);
  const capability = managementCatalog().methods.find(item => item.method === 'input.emit');
  expect(capability).toMatchObject({ parameters: INPUT_EMIT_PARAMS, ...INPUT_EMIT_CAPABILITY });
  expect(capability.schema).toBe(INPUT_EMIT_SCHEMA);
  expect(managementPolicy('input.emit').access).toBe('automatic');
  for (const rpc of cliCatalog().commands.flatMap(command => command.rpc).filter(item => item.method === 'input.emit')) {
    expect(rpc).toMatchObject({ parameters: INPUT_EMIT_PARAMS, ...INPUT_EMIT_CAPABILITY });
    expect(rpc.schema).toBe(INPUT_EMIT_SCHEMA);
  }
  expect(() => validateManagementCall('input.emit', {})).toThrow();
  expect(() => validateManagementCall('input.emit', { content: 'x', mode: 'append', target_id: 1, exclusive: true })).toThrow();
  for (const example of INPUT_EMIT_CAPABILITY.examples) {
    const before = JSON.stringify(example);
    expect(validate(example)).toBe(example);
    expect(JSON.stringify(example)).toBe(before);
  }
  const node = spawnSync('node', ['--input-type=module', '-e', `
    const p = await import(${JSON.stringify(new URL('../../src/core/input-emission-protocol.js', import.meta.url).href)});
    for (const example of p.INPUT_EMIT_CAPABILITY.examples) p.validateInputEmissionRequest(example);
    console.log(p.INPUT_EMIT_CAPABILITY.schema.title);
  `], { encoding: 'utf8' });
  expect(node.status).toBe(0); expect(node.stderr).toBe(''); expect(node.stdout.trim()).toBe('input.emit');
});

test('real Dispatcher rejects invalid shapes and unauthorized Agent requests before any draft or mount is saved', async () => {
  const f = await setup();
  try {
    const invalid = [
      {}, { content: 1 }, { content: '' }, { content: ' \n ' }, { content: 'x'.repeat(32001) },
      { content: 'x', branch: '' }, { content: 'x', branch: ' '.repeat(2) }, { content: 'x', branch: 'x'.repeat(513) },
      { content: 'x', mode: 'management' }, { content: 'x', mode: false }, { content: 'x', target_id: 1 },
      { content: 'x', mode: 'append' }, { content: 'x', mode: 'append', target_id: 0 },
      { content: 'x', mode: 'append', target_id: 1, exclusive: true },
      { content: 'x', mode: 'append', target_id: 1, profile: { agent: 'codex' } },
      { content: 'x', mode: 'append', target_id: 1, references: [reference] },
      { content: 'x', conditions: {} }, { content: 'x', conditions: Array(17).fill({ kind: 'parent_quiet' }) },
      { content: 'x', conditions: [{ kind: 'worker_settled' }] },
      { content: 'x', conditions: [{ kind: 'worker_merged', worker_id: 'W1' }] },
      { content: 'x', conditions: [{ kind: 'parent_quiet', worker_id: 1 }] },
      { content: 'x', conditions: [{ kind: 'script' }] }, { content: 'x', exclusive: 'false' },
      { content: 'x', references: {} }, { content: 'x', references: [{ kind: 'task', label: 't', quote: 'q' }] },
      { content: 'x', profile: [] }, { content: 'x', profile: { model: 'no backend' } },
      { content: 'x', profile: { agent: 'codex', thinking: 'off' } },
      ...['', ' leading', 'trailing ', 'bad\nkey', 'trailing\n', 'x'.repeat(129)].map(client_request_id => ({ content: 'x', client_request_id })),
      { draft_id: 1 }, { draft_id: 1, expected_revision: '1' }, { draft_id: 1, expected_revision: 0 },
      { draft_id: 1, expected_revision: null, mode: 'order' }, { draft_id: 1, expected_revision: 1, content: 'override' },
      { content: 'x', expected_revision: 1 }, { content: 'x', unexpected: true }, { content: 'x', runner_node_id: 1 },
    ];
    for (const request of invalid) {
      expect(() => validate(request)).toThrow();
      await expect(f.emit(request)).rejects.toMatchObject({ code: -32602 });
    }
    await expect(f.emit({ content: 'invalid identity', _token: 'not-a-user' })).rejects.toThrow('invalid or expired agent token');
    // An actual invocation-bound developer identity still cannot use the user-only RPC.
    const actor = f.store.create({ role: 'agent', task_kind: 'order', goal: 'controlled actor' });
    const token = 'controlled-input-invocation';
    f.store.update(actor.id, { status: 'running' }); f.store.armAgent(actor.id, tokenHash(token));
    f.project.running.set(actor.id, { token, controller: new AbortController() });
    try {
      await expect(f.emit({ content: 'valid shape, no authority', _token: token })).rejects.toThrow('user approval');
    } finally {
      f.project.running.delete(actor.id); f.store.armAgent(actor.id, null); f.store.update(actor.id, { status: 'paused' });
    }
    await expect(f.project.emitBufferedInput({ content: 'core path also validates', conditions: 'invalid' })).rejects.toMatchObject({ code: -32602 });
    expect(f.store.all('SELECT * FROM drafts')).toHaveLength(0);
    expect(f.store.all("SELECT * FROM events WHERE type='input.emitted'")).toHaveLength(0);
  } finally { await f.close(); }
});

test('profile/reference rules reuse canonical protocols, preserving null and Pi-default compatibility', () => {
  for (const profile of [
    { agent: 'pi' }, { agent: 'codex', model: ' local-model ', thinking: 'high', soft_budget: null },
    { agent: 'pi', config_mode: ' pi ', model: 123, env: 'ignored', thinking: 'ignored', skills: 7 },
    { agent: 'pi', append_prompt: 'explicit wins', prompt: 123 },
    { agent: 'pi', model: 'provider/model', connection_id: '12345678-1234-1234-1234-123456789abc', env: { HELLO: 'world' } },
  ]) {
    expect(() => normalizeAgentProfile(profile, 'roles.agent')).not.toThrow();
    expect(() => validate({ content: 'x', profile })).not.toThrow();
  }
  for (const profile of [{ agent: 'other' }, { agent: 'pi', env: { LUSH_HOME: 'override' } },
    { agent: 'pi', connection_id: 'not-a-uuid' }, { agent: 'codex', soft_budget: { tokens: 1 } },
    { agent: 'pi', model: 'é'.repeat(129) }, { agent: 'pi', unknown: 1 }]) {
    expect(() => normalizeAgentProfile(profile, 'roles.agent')).toThrow();
    expect(() => validate({ content: 'x', profile })).toThrow();
  }
  for (const item of [reference, { ...reference, kind: 'task', target: { task_id: '1' } },
    { ...reference, captured_at: 3, historical_extra: true }]) {
    expect(() => referenceProtocol.normalizeReferences([item])).not.toThrow();
    expect(() => validate({ content: 'x', references: [item] })).not.toThrow();
  }
  const tooLarge = Array(7).fill({ ...reference, quote: 'é'.repeat(8192) });
  expect(() => referenceProtocol.normalizeReferences(tooLarge)).toThrow();
  expect(() => validate({ content: 'x', references: tooLarge })).toThrow();
  const unchanged = { content: 'exact', mode: null, branch: null, references: null, profile: null, conditions: null, exclusive: null, target_id: null };
  expect(validate(unchanged)).toBe(unchanged);
  expect(unchanged.mode).toBeNull();
  expect(() => validate({ content: 'x', exclusive: true, conditions: Array.from({ length: 16 }, (_, i) => ({ kind: 'worker_settled', worker_id: i + 1 })) })).toThrow('including exclusive quietness');
  expect(() => validate({ content: 'x', exclusive: true, conditions: Array(16).fill({ kind: 'worker_settled', worker_id: 1 }) })).not.toThrow();
});

test('schema-valid requests mount through Dispatcher with defaults, conditions, exclusive and exact draft revisions/deduplication', async () => {
  const f = await setup();
  try {
    const request = { content: '  original\ntext  ', mode: null, references: null, conditions: null, exclusive: null, branch: null, client_request_id: 'default-order' };
    const mounted = await f.emit(validate(request));
    expect(mounted).toMatchObject({ emitted: true, mode: 'order', revision: 1, draft_number: null, dispatch: { state: 'queued' } });
    expect(mounted.task).toBeUndefined();
    expect(f.project.inputGet('draft', mounted.draft_id)).toMatchObject({ content: request.content, conditions: [], exclusive: false, branch: 'main' });
    expect(await f.emit(request)).toEqual(mounted);
    await expect(f.emit({ ...request, content: 'different' })).rejects.toThrow('different input');
    expect(f.store.all('SELECT * FROM drafts')).toHaveLength(1);
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0);

    const target = (await f.rpc.dispatch('order.submit', { content: 'paused condition target', start: false })).task;
    const conditional = await f.emit({ content: 'wait and run alone', exclusive: true, conditions: [
      { kind: 'worker_settled', worker_id: String(target.id) }, { kind: 'worker_merged', worker_id: target.id },
    ] });
    expect(conditional.dispatch).toMatchObject({ state: 'waiting_conditions', conditions: [
      { kind: 'worker_settled', worker_id: target.id, satisfied: false },
      { kind: 'worker_merged', worker_id: target.id, satisfied: false }, { kind: 'parent_quiet', satisfied: false },
    ] });
    expect(f.project.inputGet('draft', conditional.draft_id).exclusive).toBe(true);
    expect(JSON.parse(f.store.task(target.id).hooks).mounts.filter(m => m.input_signal)).toHaveLength(2);
    const appendDraft = await f.rpc.dispatch('draft.add', { content: 'saved conditional append', mode: 'append', target_id: target.id,
      conditions: [{ kind: 'worker_settled', worker_id: target.id }] });
    await expect(f.emit({ draft_id: appendDraft.id, expected_revision: 1, profile: { agent: 'codex' } })).rejects.toThrow('target Worker run settings');
    const appendReceipt = await f.emit({ draft_id: appendDraft.id, expected_revision: 1 });
    expect(appendReceipt).toMatchObject({ mode: 'append', target_id: target.id, dispatch: { state: 'waiting_conditions' } });
    await expect(f.emit({ content: 'main is not a condition Worker', conditions: [{ kind: 'worker_settled', worker_id: mounted.parent_id }] })).rejects.toThrow('development Workers');
    const saved = await f.rpc.dispatch('draft.add', { content: 'saved body', references: [reference], conditions: [{ kind: 'parent_quiet' }] });
    const edited = await f.rpc.dispatch('draft.update', { id: saved.id, expected_revision: 1, content: 'saved revision two' });
    await expect(f.emit({ draft_id: saved.id, expected_revision: 1 })).rejects.toThrow('changed');
    const draftRequest = { draft_id: String(saved.id), expected_revision: edited.revision, client_request_id: 'saved-revision' };
    const receipt = await f.emit(validate(draftRequest));
    expect(receipt).toMatchObject({ draft_id: saved.id, revision: 2, draft_number: saved.draft_number, dispatch: { state: 'waiting_conditions' } });
    expect(await f.emit(draftRequest)).toEqual(receipt);
    await expect(f.emit({ draft_id: saved.id, expected_revision: 2 })).rejects.toThrow('parameters changed');
    expect(f.project.inputGet('draft', saved.id).content).toBe('saved revision two');
    // Only a controlled isolated historical fixture; never touch a real legacy draft.
    const legacy = await f.rpc.dispatch('draft.add', { content: 'legacy body' });
    f.store.run('UPDATE drafts SET revision=NULL WHERE id=?', legacy.id);
    await expect(f.emit({ draft_id: legacy.id, expected_revision: 1 })).rejects.toThrow('changed');
    expect(await f.emit({ draft_id: legacy.id, expected_revision: null })).toMatchObject({ draft_id: legacy.id, revision: null });
    await expect(f.emit({ content: 'unknown target', mode: 'append', target_id: 999999 })).rejects.toThrow();
    f.store.update(target.id, { status: 'cancelled' });
    await expect(f.emit({ content: 'ended target', mode: 'append', target_id: target.id })).rejects.toThrow('ended');
  } finally { await f.close(); }
});

test('real Dispatcher mount -> runtime -> controlled Provider -> Input and append Message retain source_draft_id, with no duplicate execution', async () => {
  let calls = 0;
  const f = await setup({ async run() { calls++; return 'controlled input result'; } });
  try {
    const request = { content: 'real schema chain', references: [reference], client_request_id: 'real-chain' };
    const receipt = await f.emit(validate(request));
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0); expect(calls).toBe(0);
    f.project.stopping = false; f.project.kick();
    await until(() => f.project.inputEmissionResult(receipt.draft_id).dispatch.state === 'succeeded');
    const dispatch = f.project.inputEmissionResult(receipt.draft_id).dispatch;
    await until(() => f.store.task(dispatch.worker_id).result && !f.project.running.has(dispatch.worker_id));
    f.project.stopping = true;
    expect(calls).toBe(1);
    expect(f.project.inputGet('input', dispatch.input_id)).toMatchObject({ content: request.content, source_draft_id: receipt.draft_id });
    expect((await f.emit(request)).dispatch).toMatchObject(dispatch);
    expect(calls).toBe(1);
    const appendRequest = { content: 'follow-up verbatim', mode: 'append', target_id: String(dispatch.worker_id), client_request_id: 'append-chain' };
    const append = await f.emit(validate(appendRequest));
    expect(append.dispatch.state).toBe('queued');
    f.project.stopping = false; f.project.kick();
    await until(() => f.project.inputEmissionResult(append.draft_id).dispatch.state === 'succeeded');
    const delivered = f.project.inputEmissionResult(append.draft_id).dispatch;
    expect(delivered.input_id).toBeUndefined(); expect(delivered.message_id).toBeGreaterThan(0);
    expect(f.project.inputGet('message', delivered.message_id)).toMatchObject({ content: appendRequest.content, source_draft_id: append.draft_id });
    expect((await f.emit(appendRequest)).dispatch.message_id).toBe(delivered.message_id);
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(1);
    expect(f.store.all('SELECT * FROM messages WHERE id=?', delivered.message_id)).toHaveLength(1);
  } finally { await f.close(); }
});
