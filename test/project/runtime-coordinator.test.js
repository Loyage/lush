import { test, expect, spyOn } from 'bun:test';
import { fixture, gate, until } from '../helpers.js';

const turn = () => new Promise(resolve => setImmediate(resolve));

test('Project routes the three check entrypoints through one fixed, coalescing registry', async () => {
  const f = fixture();
  const calls = [];
  f.project.pump = () => calls.push('agents');
  f.project.observeTaskHooks = () => calls.push('hooks');
  f.project.drainInputEmissions = async () => { calls.push('inputs'); };
  try {
    for (let i = 0; i < 100; i++) {
      f.project.kick(); f.project.scheduleTaskHooks(); f.project.scheduleInputEmissions();
    }
    expect(calls).toEqual([]);
    expect(f.project.runtimeCoordinator.pendingCount).toBe(3);
    await turn();
    expect(calls).toEqual(['agents', 'hooks', 'inputs']);
    expect(f.project.runtimeCoordinator.runningCount).toBe(0);
    f.project.stopping = true;
    f.project.kick(); f.project.scheduleTaskHooks(); f.project.scheduleInputEmissions();
    await turn();
    expect(calls).toHaveLength(3);
    expect(f.project.runtimeCoordinator.pendingCount).toBe(0);
    f.project.stopping = false;
    f.project.recoveringHooks = true; f.project.scheduleInputEmissions();
    await turn(); expect(calls).toHaveLength(3);
    f.project.recoveringHooks = false; f.project.scheduleInputEmissions();
    await turn(); expect(calls).toEqual(['agents', 'hooks', 'inputs', 'inputs']);
  } finally { await f.close(); }
});

test('input check retains a busy-time wake without overlapping or blocking agents and hooks', async () => {
  const f = fixture(), held = gate();
  let calls = 0, active = 0, maxActive = 0, agents = 0, hooks = 0;
  f.project.pump = () => { agents++; };
  f.project.observeTaskHooks = () => { hooks++; };
  f.project.drainInputEmissions = async () => {
    active++; maxActive = Math.max(active, maxActive);
    if (++calls === 1) await held.promise;
    active--;
  };
  try {
    f.project.scheduleInputEmissions(); await turn();
    for (let i = 0; i < 100; i++) f.project.scheduleInputEmissions();
    f.project.kick(); f.project.scheduleTaskHooks(); await turn();
    expect(calls).toBe(1); expect(agents).toBe(1); expect(hooks).toBe(1);
    expect(f.project.runtimeCoordinator.pendingCount).toBe(1);
    held.resolve(); await until(() => calls === 2 && active === 0);
    await turn(); expect(calls).toBe(2); expect(maxActive).toBe(1);
  } finally { held.resolve(); await f.close(); }
});

test('maintenance sees admitted checks and shutdown waits for them while dropping late requests', async () => {
  const f = fixture(), held = gate(); let calls = 0, late = 0;
  f.project.pump = () => { late++; };
  f.project.observeTaskHooks = () => { late++; };
  f.project.drainInputEmissions = async () => { calls++; await held.promise; };
  try {
    f.project.scheduleInputEmissions(); await turn();
    expect(f.project.running.size).toBe(0); expect(f.project.writing).toBe(0);
    expect(f.project.maintenanceView().ready_to_restart).toBe(false);
    f.project.scheduleInputEmissions(); f.project.kick(); f.project.scheduleTaskHooks();
    let stopped = false;
    const stopping = f.project.shutdown().then(() => { stopped = true; });
    await turn(); expect(stopped).toBe(false);
    expect(f.project.runtimeCoordinator.pendingCount).toBe(0);
    f.project.kick(); f.project.scheduleInputEmissions();
    held.resolve(); await stopping; await turn();
    expect(calls).toBe(1); expect(late).toBe(0);
    expect(f.project.runtimeCoordinator.runningCount).toBe(0);
    f.project.stopping = false; f.project.kick(); await turn();
    expect(late).toBe(0); // shutdown permanently closes this instance
  } finally { held.resolve(); await f.close(); }
});

test('a failed input check is reported without retrying and does not strand other check types', async () => {
  const f = fixture(); let inputs = 0, agents = 0;
  f.project.drainInputEmissions = async () => { inputs++; throw new Error('controlled check failure'); };
  f.project.pump = () => { agents++; };
  const log = spyOn(console, 'error').mockImplementation(() => {});
  try {
    f.project.scheduleInputEmissions(); f.project.kick(); await turn(); await turn();
    expect(inputs).toBe(1); expect(agents).toBe(1);
    expect(log).toHaveBeenCalledWith('runtime check inputs:', 'controlled check failure');
    f.project.scheduleInputEmissions(); await turn(); expect(inputs).toBe(2);
  } finally { log.mockRestore(); await f.close(); }
});

test('coordinator ownership is per Project, not device-wide or shared between projects', async () => {
  const a = fixture(), b = fixture(); let first = 0, second = 0;
  a.project.pump = () => { first++; }; b.project.pump = () => { second++; };
  try {
    a.project.kick(); await turn(); expect(first).toBe(1); expect(second).toBe(0);
    await a.project.shutdown(); b.project.kick(); await turn();
    expect(first).toBe(1); expect(second).toBe(1);
  } finally { await a.close(); await b.close(); }
});
