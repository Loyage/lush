import { test, expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { fixture, gate } from './helpers.js';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { createSignal } from '../src/signal.js';
import { managementState, saveManagement } from '../src/core/project/management-data.js';
import { trackControlJob } from '../src/core/project/management-control.js';
import { managementPolicy } from '../src/rpc/management-policy.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const definition = (kind, key, instruction, rest = {}) => canonical({ kind, mode: 'administrator', scope: 'current_project',
  client_request_id: key, instruction, ...rest });

// Replaces the retired device ADM runtime flow. This native identity has one representative
// occurrence chain; actual Web password/signature/Provider integration is the parent instruction's responsibility.
test('native V occurrence accepts one verified elevation, defaults the next input to ordinary, and retains real async/unknown stop ownership', async () => {
  const grants = new Map(), invocations = [], completion = gate();
  let f, dispatcher, tracked;
  const issue = value => {
    const proof = { fixture_proof: randomUUID(), signature: 'RAW_PROOF_SIGNATURE_CANARY' };
    grants.set(proof.fixture_proof, { definition: canonical(value), grant_id: randomUUID(),
      definition_hash: hash(JSON.stringify(canonical(value))), verified_at: new Date().toISOString() });
    return proof;
  };
  const verify = proof => {
    if (!proof || Object.keys(proof).sort().join(',') !== 'fixture_proof,signature' || !grants.has(proof.fixture_proof)) throw Error('fixture proof rejected');
    return structuredClone(grants.get(proof.fixture_proof));
  };
  f = fixture({ async run(options) {
    const context = options.context.management;
    invocations.push({ context, instruction: context.instruction });
    await expect(dispatcher.dispatch('management.elevation_receipt', { client_request_id: 'first_high', _token: options.token })).rejects.toThrow('user approval');
    if (context.authorization.mode === 'administrator') {
      const state = managementState(f.store.task(options.task.id)), elevation = state.pending_signal.elevation;
      expect(elevation.instruction_hash).toBe(hash(context.instruction));
      expect(context.management.pending_signal.authority).toEqual({ mode: 'administrator', scope: 'current_project' });
      expect(() => f.project.notice(options.task.id, 'cannot resume high authority without another password', '', 'question')).toThrow('password');
      expect(f.store.get("SELECT count(*) AS n FROM notices WHERE task_id=? AND status='open'", options.task.id).n).toBe(0);
      if (context.instruction === 'high append with independent owner') {
        const receiptId = f.store.event(options.task.id, 'management.capability_requested', { occurrence_id: state.pending_signal.id, method: 'manager.administrator_call' });
        state.control_calls.push({ receipt_id: receiptId, occurrence_id: state.pending_signal.id, method: 'manager.administrator_call', status: 'running',
          reason: 'ORIGINAL_UNKNOWN_FAILURE_CANARY' });
        saveManagement(f.project, options.task.id, state);
        tracked = trackControlJob(f.project, options.task.id, completion.promise);
      }
      return 'HIGH_RESULT_CANARY';
    }
    if (context.instruction === 'ordinary after high') {
      expect(context.management.last_execution).toBeNull();
      expect(context.decisions).toEqual([]);
      expect(JSON.stringify(context)).not.toContain('HIGH_RESULT_CANARY');
      expect(JSON.stringify(context)).not.toContain('HIGH_ERROR_CANARY');
    }
    return 'ordinary result';
  } });
  try {
    f.project.kick = () => {};
    dispatcher = new Dispatcher(f.project, createSignal(), {});
    delete f.project.verifyProjectElevationProof; // Explicitly test the native missing-adapter boundary before injecting the fixture verifier.
    const pump = async () => { f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise)); };
    const firstDefinition = definition('submit', 'first_high', ' first native high input\nkeep whitespace ');
    const firstProof = issue(firstDefinition);
    await expect(dispatcher.dispatch('management.elevated_submit', { proof: firstProof })).rejects.toThrow('not configured');
    f.project.verifyProjectElevationProof = () => true;
    await expect(dispatcher.dispatch('management.elevated_submit', { proof: true })).rejects.toThrow('synchronous');
    f.project.verifyProjectElevationProof = verify;
    await expect(dispatcher.dispatch('management.elevated_submit', { proof: firstProof, _token: null })).rejects.toThrow('Agent credentials');
    await expect(dispatcher.dispatch('management.elevated_submit', { proof: firstProof, elevated: true })).rejects.toThrow('unknown parameter');
    for (const method of ['management.elevated_submit', 'management.elevated_append', 'management.elevation_receipt']) expect(managementPolicy(method).access).toBe('unavailable');
    expect(() => f.project.submitManagementInstruction({ instruction: 'cannot self elevate', elevation: true })).toThrow('fields');
    const ordinary = f.project.submitManagementInstruction({ instruction: 'ordinary first', client_request_id: 'ordinary_key' }).task;
    await pump();
    await expect(dispatcher.dispatch('management.elevated_submit', { proof: issue(definition('submit', 'ordinary_key', 'ordinary first')) })).rejects.toThrow('ordinary management');
    expect(f.project.managementView(ordinary.id).last_execution.authority.mode).toBe('ordinary');
    const changedHash = issue(definition('submit', 'bad_hash', 'original'));
    grants.get(changedHash.fixture_proof).definition.instruction = 'changed after verification';
    await expect(dispatcher.dispatch('management.elevated_submit', { proof: changedHash })).rejects.toThrow('definition changed');
    const made = await dispatcher.dispatch('management.elevated_submit', { proof: firstProof });
    const task = made.task, state = managementState(f.store.task(task.id)), elevation = state.pending_signal.elevation;
    expect(task).toMatchObject({ role: 'manager', task_kind: 'management', input_id: null, branch: null, status: 'queued' });
    expect(task.worker_number).toMatch(/^V[1-9]\d*$/);
    expect(elevation).toMatchObject({ version: 1, mode: 'administrator', scope: 'current_project', project: f.config.project,
      occurrence_id: state.pending_signal.id, instruction_hash: hash(firstDefinition.instruction), definition_hash: hash(JSON.stringify(firstDefinition)) });
    const source = f.store.get('SELECT task_id,data FROM events WHERE id=?', elevation.source_event_id);
    expect(source.task_id).toBe(task.id);
    expect(JSON.parse(source.data)).toMatchObject({ grant_id: elevation.grant_id, definition_hash: elevation.definition_hash,
      instruction_hash: elevation.instruction_hash, occurrence_id: elevation.occurrence_id });
    const duplicate = await dispatcher.dispatch('management.elevated_submit', { proof: firstProof });
    expect(duplicate.task.id).toBe(task.id);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='management.elevation_accepted'", task.id).n).toBe(1);
    await expect(dispatcher.dispatch('management.elevated_submit', { proof: issue({ ...firstDefinition, instruction: 'different body' }) })).rejects.toThrow('different elevation');
    expect(() => f.project.submitManagementInstruction({ instruction: firstDefinition.instruction, client_request_id: firstDefinition.client_request_id })).toThrow('password-elevated');
    expect(await dispatcher.dispatch('management.elevation_receipt', { client_request_id: 'first_high' })).toMatchObject({ version: 1, found: true,
      definition: firstDefinition, task: { id: task.id, status: 'queued' }, instruction: firstDefinition.instruction });
    expect(JSON.stringify(f.store.all("SELECT data FROM events WHERE task_id=?", task.id))).not.toContain('RAW_PROOF_SIGNATURE_CANARY');
    expect(JSON.stringify(task.management)).not.toContain('grant_id');
    await pump();
    expect(f.project.managementView(task.id)).toMatchObject({ authority: { mode: 'ordinary' }, last_execution: { authority: { mode: 'administrator' }, status: 'succeeded' } });
    expect(f.store.task(task.id).result).toBe('HIGH_RESULT_CANARY'); // User history remains readable.
    const highHistory = managementState(f.store.task(task.id)); highHistory.last_execution.reason = 'HIGH_ERROR_CANARY'; saveManagement(f.project, task.id, highHistory);
    await dispatcher.dispatch('worker.message', { id: task.id, body: 'ordinary after high' });
    expect(managementState(f.store.task(task.id)).pending_signal.elevation).toBeUndefined();
    expect(f.project.managementView(task.id)).toMatchObject({ authority: { mode: 'ordinary' }, pending_signal: { authority: { mode: 'ordinary' } }, last_execution: { authority: { mode: 'administrator' } } });
    await pump();
    expect(invocations.map(call => call.context.authorization.mode)).toEqual(['ordinary', 'administrator', 'ordinary']);
    expect(f.store.task(task.id).worker_number).toBe(task.worker_number);
    const appendDefinition = definition('append', 'second_high', 'high append with independent owner', { id: task.id });
    const appendProof = issue(appendDefinition);
    const appended = await dispatcher.dispatch('management.elevated_append', { proof: appendProof });
    expect(appended.task.id).toBe(task.id);
    await pump();
    expect(f.project.running.has(task.id)).toBe(false);
    expect(f.project.managementOccupant().id).toBe(task.id); // Provider exit does not release the async tool owner.
    await expect(dispatcher.dispatch('worker.message', { id: task.id, body: 'cannot overtake the original owner' })).rejects.toThrow('收口');
    const pending = managementState(f.store.task(task.id));
    expect(pending.pending_signal.elevation.occurrence_id).not.toBe(elevation.occurrence_id);
    const emergency = f.project.managementEmergencyPreview();
    expect(f.project.managementEmergencyStop(emergency.revision, true).status).toBe('stopping');
    expect(f.project.managementOccupant().id).toBe(task.id);
    pending.control_calls[0].status = 'unknown';
    const stoppedState = managementState(f.store.task(task.id)); stoppedState.control_calls[0].status = 'unknown'; saveManagement(f.project, task.id, stoppedState);
    completion.resolve(); await tracked;
    expect(f.project.managementView(task.id).emergency.status).toBe('isolated');
    expect(f.project.managementOccupant()).toBeNull();
    expect(managementState(f.store.task(task.id)).control_calls[0]).toMatchObject({ status: 'unknown', reason: 'ORIGINAL_UNKNOWN_FAILURE_CANARY' });
    const replay = await dispatcher.dispatch('management.elevated_append', { proof: appendProof });
    expect(replay.task.status).toBe('cancelled');
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='management.elevation_accepted'", task.id).n).toBe(2);
    delete f.project.verifyProjectElevationProof;
    expect(await dispatcher.dispatch('management.elevation_receipt', { client_request_id: 'second_high' })).toMatchObject({ found: true, definition: appendDefinition, task: { id: task.id, status: 'cancelled' } });
    await expect(dispatcher.dispatch('management.elevated_append', { proof: appendProof })).rejects.toThrow('not configured');
    f.project.recoverManagementWorkers();
    expect(managementState(f.store.task(task.id)).control_calls[0].status).toBe('unknown');
    expect(() => f.project.submitManagementSignal(task.id, { id: 100, elevation: { mode: 'administrator' } })).toThrow('elevation');
  } finally { completion.resolve(); await tracked; await f.close(); }
});
