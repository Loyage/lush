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
