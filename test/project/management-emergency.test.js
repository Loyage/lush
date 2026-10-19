import { test, expect } from 'bun:test';
import { setup, fetch } from '../web/harness.js';
import { managementState, saveManagement } from '../../src/core/project/management-data.js';

test('user HTTP emergency isolates unknown ownership without replay and permits a fresh management instruction', async () => {
  const f = await setup();
  try {
    f.project.kick = () => {};
    const old = f.store.create({ role: 'manager', task_kind: 'management', goal: 'PRIVATE-INSTRUCTION', name: 'history' });
    const occurrence = f.store.event(old.id, 'management.input_submitted', {});
    saveManagement(f.project, old.id, { version: 1, config_revision: 1, mode: 'once', enabled: false, consumed: false,
      signal_id: null, state: 'unknown', pending_signal: { id: occurrence, phase: 'started', run_id: 999 },
      receipts: [{ receipt_id: occurrence, status: 'unknown', reason: 'PRIVATE-HISTORY' }], control_calls: [],
      last_execution: { id: occurrence, status: 'unknown', reason: 'PRIVATE-HISTORY' } });
    f.store.update(old.id, { status: 'failed' });
    const original = managementState(f.store.task(old.id));
    expect(() => f.project.submitManagementInstruction({ instruction: 'blocked' })).toThrow('已有管家');
    const preview = await (await fetch(f.url + '/api/management/emergency-preview')).json();
    expect(preview).toMatchObject({ affected_total: 1, history_preserved: true });
    expect(JSON.stringify(preview)).not.toContain('PRIVATE-');
    const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'management.emergency_stop', params: { revision: preview.revision, confirm: true } }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'isolated', isolated_total: 1, stopping_total: 0 });
    const isolated = managementState(f.store.task(old.id));
    expect(isolated).toMatchObject({ enabled: false, consumed: true, state: 'unknown', emergency: { status: 'isolated' } });
    expect(isolated.receipts).toEqual(original.receipts);
    expect(isolated.pending_signal).toEqual(original.pending_signal);
    const created = f.project.submitManagementInstruction({ instruction: 'new explicit authorization' });
    expect(created).toMatchObject({ management: true, task: { status: 'queued' } });
    expect(f.project.managementOccupant().id).toBe(created.task.id);
  } finally { await f.close(); }
});
