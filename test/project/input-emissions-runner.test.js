import { test, expect } from 'bun:test';
import { fixture, repo } from '../helpers.js';
import { Store } from '../../src/persistence/store.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { inputOptions, normalizeInputOptions, definitionHash } from '../../src/core/project/input-emission-data.js';
import { hash } from '../../src/runner/protocol.js';
import path from 'node:path';
import { remoteProfile } from './fixtures/runner-project.js';

async function setup() {
  const f = fixture({ resolve: () => remoteProfile }); f.project.stopping = true; f.project.kick = () => {};
  await repo(f.root); await f.project.ensureMainTask();
  const service = f.project.runners;
  const saved = await service.saveNodes({ nodes: [{ name: 'Emission fixture', ssh_alias: 'fixture', enabled: true, expected_runner_id: 'installation',
    budgets: { max_commands: 1, timeout_ms: 1000, output_bytes: 4096 } }] }, service.readNodes().revision);
  const node = saved.nodes[0];
  const policy = (await service.savePolicy({ allowed_node_ids: [node.id], default_node_id: 'local' }, 0)).policy;
  await service.saveCredentials({ node_id: node.id, project_id: policy.project_id, machine_token: hash('fixture-machine'), control_token: hash('fixture-project') }, 'absent');
  return { ...f, node, service, async close() { await service.close(); await f.close(); } };
}
async function drain(f) { f.project.stopping = false; try { await f.project.drainInputEmissions(); } finally { f.project.stopping = true; } }

test('Runner selection survives draft edits and Store reopen; omitted legacy options/hash stay unchanged', async () => {
  const f = await setup();
  try {
    const legacy = { mode: 'order', conditions: [], exclusive: false };
    expect(normalizeInputOptions(f.project)).toEqual(legacy);
    expect(definitionHash(normalizeInputOptions(f.project))).toBe(definitionHash(legacy));
    const draft = await f.project.addBufferedDraft('selected', [], 'main', { runner_node_id: f.node.id });
    expect(draft.runner_node_id).toBe(f.node.id);
    const edited = await f.project.updateBufferedDraft(draft.id, 'edited', undefined, undefined, draft.revision, {});
    expect(edited.runner_node_id).toBe(f.node.id);
    expect(f.project.inputHistory({ view: 'drafts' }).items.find(row => row.id === draft.id).runner_node_id).toBe(f.node.id);
    const before = f.store.draft(draft.id);
    for (const options of [{ runner_node_id: '' }, { mode: 'append', target_id: 1 }, { mode: 'management' }])
      await expect(f.project.updateBufferedDraft(draft.id, 'bad edit', undefined, undefined, edited.revision, options)).rejects.toThrow();
    expect(f.store.draft(draft.id)).toEqual(before);
    expect(() => f.project.submitBufferedDraft(draft.id, edited.revision, false, true)).toThrow('must use input.emit');
    const reopened = new Store(path.join(f.config.home, 'project.db'), f.root);
    try { expect(inputOptions(reopened.draft(draft.id)).runner_node_id).toBe(f.node.id); } finally { reopened.close(); }
  } finally { await f.close(); }
});

test('RPC draft reset removes placement durably, preserves revision protection and leaves creation validation strict', async () => {
  const f = await setup(); const rpc = new Dispatcher(f.project);
  try {
    const draft = await rpc.dispatch('draft.add', { content: 'selected', branch: 'main', runner_node_id: f.node.id });
    const patch = { id: draft.id, content: 'reset', expected_revision: draft.revision, runner_node_id: null };
    await expect(rpc.dispatch('draft.update', { ...patch, expected_revision: draft.revision + 1 })).rejects.toThrow('changed');
    expect(inputOptions(f.store.draft(draft.id)).runner_node_id).toBe(f.node.id);
    const cleared = await rpc.dispatch('draft.update', patch);
    expect(cleared.revision).toBe(draft.revision + 1);
    expect(Object.hasOwn(cleared, 'runner_node_id')).toBe(false);
    const legacy = { mode: 'order', conditions: [], exclusive: false };
    expect(inputOptions(f.store.draft(draft.id))).toEqual(legacy);
    expect(definitionHash(inputOptions(f.store.draft(draft.id)))).toBe(definitionHash(legacy));
    expect(Object.hasOwn(f.project.inputHistory({ view: 'drafts' }).items.find(row => row.id === draft.id), 'runner_node_id')).toBe(false);
    const reopened = new Store(path.join(f.config.home, 'project.db'), f.root);
    try { expect(inputOptions(reopened.draft(draft.id))).toEqual(legacy); } finally { reopened.close(); }
    const kept = await rpc.dispatch('draft.update', { id: draft.id, content: 'still default', expected_revision: cleared.revision });
    expect(Object.hasOwn(kept, 'runner_node_id')).toBe(false);
    await expect(rpc.dispatch('draft.update', { ...patch, expected_revision: kept.revision, mode: 'append', target_id: 1 })).rejects.toThrow('order input mode');
    for (const method of ['draft.add', 'input.emit', 'order.submit'])
      await expect(rpc.dispatch(method, { content: 'invalid null', runner_node_id: null })).rejects.toThrow('runner_node_id');
    expect(f.store.draftCount()).toBe(1);
    await rpc.dispatch('input.emit', { draft_id: draft.id, expected_revision: kept.revision });
    await expect(rpc.dispatch('draft.update', { ...patch, expected_revision: kept.revision })).rejects.toThrow('mounted input');
  } finally { await f.close(); }
});

test('actual emission admission checks current node authorization before consuming text; append cannot carry placement', async () => {
  const f = await setup();
  try {
    const policy = f.service.readPolicy();
    await f.service.savePolicy({ allowed_node_ids: [], default_node_id: 'local' }, policy.revision);
    await expect(f.project.emitBufferedInput({ content: 'no authorization', runner_node_id: f.node.id })).rejects.toThrow('not authorized');
    expect(f.store.draftCount()).toBe(0);
    await expect(f.project.emitBufferedInput({ content: 'not a new Worker', mode: 'append', target_id: 1, runner_node_id: 'local' })).rejects.toThrow('order input mode');
    expect(f.store.draftCount()).toBe(0);
    const draft = await f.project.addBufferedDraft('retain offline selection', [], 'main', { runner_node_id: f.node.id });
    await expect(f.project.emitBufferedInput({ draft_id: draft.id, expected_revision: draft.revision })).rejects.toThrow('not authorized');
    expect(inputOptions(f.store.draft(draft.id)).runner_node_id).toBe(f.node.id);
    expect(f.store.draft(draft.id).emission).toBeNull();
  } finally { await f.close(); }
});

test('emission and dispatch share creation support checks after resolving the profile', async () => {
  const f = await setup(); let calls = 0;
  f.project.sendOrder = async () => { calls++; throw new Error('must not reach unsupported creation'); };
  try {
    f.project.provider.resolve = () => ({ agent: 'codex' });
    await expect(f.project.emitBufferedInput({ content: 'unsupported', runner_node_id: f.node.id })).rejects.toThrow('controlled Lush Pi');
    expect(f.store.all('SELECT emission FROM drafts').every(row => row.emission === null)).toBe(true);
    f.project.provider.resolve = () => remoteProfile;
    const emitted = await f.project.emitBufferedInput({ content: 'supported at admission', runner_node_id: f.node.id });
    f.project.provider.resolve = () => ({ ...remoteProfile, extensions: ['unsupported-extension'] });
    await drain(f);
    expect(calls).toBe(0);
    expect(f.project.inputEmissionResult(emitted.draft_id).dispatch.state).toBe('failed');
    expect(inputOptions(f.store.draft(emitted.draft_id)).runner_node_id).toBe(f.node.id);
  } finally { await f.close(); }
});

test('keyed emission fixes explicit placement; revised request and mounted draft edit cannot redirect it', async () => {
  const f = await setup();
  try {
    const params = { content: 'same input', runner_node_id: f.node.id, client_request_id: 'fixed-node' };
    const first = await f.project.emitBufferedInput(params), repeated = await f.project.emitBufferedInput(params);
    expect(repeated).toEqual(first); expect(first.runner_node_id).toBe(f.node.id);
    expect(f.store.draftCount()).toBe(1);
    await expect(f.project.emitBufferedInput({ ...params, runner_node_id: 'local' })).rejects.toThrow('different input');
    const { runner_node_id, ...omitted } = params;
    await expect(f.project.emitBufferedInput(omitted)).rejects.toThrow('different input');
    await expect(f.project.updateBufferedDraft(first.draft_id, 'redirect', undefined, undefined, first.revision, { runner_node_id: 'local' })).rejects.toThrow('mounted input');
    expect(inputOptions(f.store.draft(first.draft_id)).runner_node_id).toBe(f.node.id);
    expect(f.store.draftCount()).toBe(1);
  } finally { await f.close(); }
});

test('revocation before dispatch fails without sendOrder or changing selection; restored authorization does not replay failed input', async () => {
  const f = await setup(); let calls = 0;
  f.project.sendOrder = async () => { calls++; throw new Error('must not reach creation'); };
  try {
    const emitted = await f.project.emitBufferedInput({ content: 'pending', runner_node_id: f.node.id });
    const current = f.service.readNodes();
    await f.service.saveNodes({ nodes: [{ ...current.nodes[0], enabled: false }] }, current.revision);
    await drain(f);
    expect(calls).toBe(0); expect(f.project.inputEmissionResult(emitted.draft_id).dispatch.state).toBe('failed');
    expect(inputOptions(f.store.draft(emitted.draft_id)).runner_node_id).toBe(f.node.id);
    const disabled = f.service.readNodes();
    await f.service.saveNodes({ nodes: [{ ...disabled.nodes[0], enabled: true }] }, disabled.revision);
    f.project.recoverInputEmissions(); await drain(f);
    expect(calls).toBe(0); expect(f.project.inputEmissionResult(emitted.draft_id).dispatch.state).toBe('failed');
  } finally { await f.close(); }
});

test('dispatch forwards the persisted thirteenth sendOrder argument and live guard; failed creation preserves node', async () => {
  const f = await setup(); let captured;
  // Deliberately stop at the owned API seam. Parent W298-6 supplies real creation/Git/Runner coverage.
  f.project.sendOrder = async (...args) => { captured = args; args[9](); throw new Error('controlled creation failure'); };
  try {
    const draft = await f.project.addBufferedDraft('selected draft', [], 'main', { runner_node_id: f.node.id });
    const emitted = await f.project.emitBufferedInput({ draft_id: draft.id, expected_revision: draft.revision });
    await drain(f);
    expect(captured).toHaveLength(13); expect(captured[12]).toBe(f.node.id);
    expect(captured[3]).toBeNull(); expect(captured[11].draft_id).toBe(draft.id);
    expect(f.project.inputEmissionResult(emitted.draft_id).dispatch.state).toBe('failed');
    expect(inputOptions(f.store.draft(draft.id)).runner_node_id).toBe(f.node.id);
    expect(f.store.all("SELECT id FROM tasks WHERE task_kind='order'")).toEqual([]);
  } finally { await f.close(); }
});
