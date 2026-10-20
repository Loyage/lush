import { test, expect } from 'bun:test';
import { setup, fetch } from '../web/harness.js';
import { managementState, saveManagement } from '../../src/core/project/management-data.js';

test('user HTTP emergency isolates only lane occupants, preserves healthy history and future bindings, and permits fresh input', async () => {
  const f = await setup();
  try {
    f.project.kick = () => {};
    const healthy = [
      { status: 'completed', state: 'idle', enabled: false, consumed: true,
        last_execution: { id: 1, status: 'succeeded', started_at: new Date().toISOString() } },
      { status: 'waiting', state: 'idle', enabled: true, consumed: false, signal_id: 'future-signal' },
      { status: 'failed', state: 'failed', enabled: false, consumed: true,
        pending_signal: { id: 2, phase: 'started' }, last_execution: { id: 2, status: 'unknown' } },
    ].map(({ status, ...state }) => {
      const task = f.store.create({ role: 'manager', task_kind: 'management', goal: 'unoccupied history' });
      saveManagement(f.project, task.id, { version: 1, config_revision: 1, mode: 'once',
        pending_signal: null, receipts: [], control_calls: [], ...state });
      f.store.update(task.id, { status });
      return f.store.task(task.id);
    });
    expect(f.project.managementOccupant()).toBeNull();
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
    expect(preview).toMatchObject({ total: 4, affected_total: 1, history_preserved: true });
    expect(preview.items.map(item => item.id)).toEqual([old.id]);
    expect(JSON.stringify(preview)).not.toContain('PRIVATE-');
    const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'management.emergency_stop', params: { revision: preview.revision, confirm: true } }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'isolated', isolated_total: 1, stopping_total: 0 });
    const isolated = managementState(f.store.task(old.id));
    expect(isolated).toMatchObject({ enabled: false, consumed: true, state: 'unknown', emergency: { status: 'isolated' } });
    expect(isolated.receipts).toEqual(original.receipts);
    expect(isolated.pending_signal).toEqual(original.pending_signal);
    for (const task of healthy) expect(f.store.task(task.id)).toEqual(task);
    expect(f.project.managementView(healthy[0].id).can_append).toBe(true);
    const clean = f.project.managementEmergencyPreview();
    expect(clean).toMatchObject({ total: 4, affected_total: 0, already_isolated_total: 1 });
    expect(f.project.managementEmergencyStop(clean.revision, true)).toMatchObject({ affected_total: 0, status: 'isolated' });
    for (const task of healthy) expect(f.store.task(task.id)).toEqual(task);
    const created = f.project.submitManagementInstruction({ instruction: 'new explicit authorization' });
    expect(created).toMatchObject({ management: true, task: { status: 'queued' } });
    expect(f.project.managementOccupant().id).toBe(created.task.id);
    // Queued work and actual runtime ownership still require real cleanup.
    const controller = new AbortController();
    f.project.running.set(created.task.id, { controller, recordId: 1000 });
    f.project.managementControlOwners ??= new Map();
    f.project.managementControlOwners.set(created.task.id, 1);
    const live = f.project.managementEmergencyPreview();
    expect(live).toMatchObject({ affected_total: 1, totals: { live_workers: 1 } });
    expect(f.project.managementEmergencyStop(live.revision, true)).toMatchObject({ status: 'stopping', stopping_total: 1 });
    expect(controller.signal.aborted).toBe(true);
    expect(f.project.managementOccupant().id).toBe(created.task.id);
    f.project.running.delete(created.task.id);
    f.project.settleManagementEmergency(created.task.id);
    expect(f.project.managementOccupant().id).toBe(created.task.id);
    f.project.managementControlOwners.delete(created.task.id);
    f.project.settleManagementEmergency(created.task.id);
    expect(f.project.managementOccupant()).toBeNull();
    // A transport retry reports its original set, not the later explicit input.
    const next = f.project.submitManagementInstruction({ instruction: 'later explicit input' }).task;
    expect(f.project.managementEmergencyStop(live.revision, true)).toMatchObject({ affected_total: 1, status: 'isolated' });
    expect(f.store.task(next.id).status).toBe('queued');
    for (const task of healthy) expect(f.store.task(task.id)).toEqual(task);
  } finally { await f.close(); }
});
