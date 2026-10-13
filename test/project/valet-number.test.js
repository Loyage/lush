import path from 'node:path';
import { test, expect } from 'bun:test';
import { fixture } from '../helpers.js';
import { Store } from '../../src/persistence/store.js';
import { workerNumber } from '../../src/core/worker-number.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { tokenHash } from '../../src/core/project/internal.js';

const valet = store => store.create({ role: 'manager', task_kind: 'management', input_id: null, goal: 'manage' });

test('Valet numbering is project-local, independent, transactional, unique and immutable through Store patches', async () => {
  const f = fixture(), isolated = fixture(); f.project.stopping = isolated.project.stopping = true;
  try {
    const first = valet(f.store);
    expect(first).toMatchObject({ worker_number: 'V1', role: 'manager', task_kind: 'management', parent_id: null, input_id: null });
    expect(valet(isolated.store).worker_number).toBe('V1');
    const input = f.store.nextInputId(); f.store.run('INSERT INTO inputs(id,content) VALUES (?,?)', input, 'develop');
    const root = f.store.create({ role: 'agent', task_kind: 'order', input_id: input, goal: 'develop' });
    expect(root.worker_number).toBe(`W${input}`);
    expect(f.store.create({ role: 'agent', task_kind: 'child', parent_id: root.id, goal: 'child' }).worker_number).toBe(`${root.worker_number}-1`);
    expect(() => f.store.transaction(() => { valet(f.store); throw new Error('rollback'); })).toThrow('rollback');
    expect(() => f.store.create({ role: 'manager', task_kind: 'management', input_id: 999999, goal: 'bad FK' })).toThrow('FOREIGN KEY');
    const second = valet(f.store);
    expect(second.worker_number).toBe('V2');
    expect(() => f.store.update(second.id, { worker_number: 'V8' })).toThrow('invalid task patch');
    expect(() => f.store.run('UPDATE tasks SET worker_number=? WHERE id=?', first.worker_number, second.id)).toThrow('UNIQUE');
    expect(() => f.store.create({ role: 'agent', task_kind: 'child', parent_id: first.id, goal: 'not a development parent' })).toThrow('W-numbered parent');
    expect(f.store.get('SELECT value FROM meta WHERE key=?', `worker_child_high:${first.id}`)).toBeNull();
    expect(valet(f.store).worker_number).toBe('V3');
  } finally { await f.close(); await isolated.close(); }
});

test('Valet high-water survives targeted deletion, reopen and purge; legacy management rows remain unnumbered', async () => {
  const f = fixture(); f.project.stopping = true; let reopened;
  try {
    f.store.run("INSERT INTO tasks(id,role,goal,task_kind,management) VALUES (88,'manager','legacy','management',?)", JSON.stringify({ version: 1, state: 'stopped' }));
    const legacy = f.store.task(88);
    const first = valet(f.store), second = valet(f.store);
    f.store.hardDeleteTasks([second.id]);
    reopened = new Store(path.join(f.config.home, 'project.db'), f.root);
    expect(reopened.task(88)).toEqual(legacy);
    expect(legacy.worker_number).toBeNull();
    expect(() => reopened.create({ role: 'agent', task_kind: 'child', parent_id: legacy.id, goal: 'not a developer' })).toThrow('not a Valet');
    expect(valet(reopened).worker_number).toBe('V3');
    f.store.deleteTasks([first.id]);
    expect(() => reopened.lookupWorker('V1')).toThrow('not found');
    expect(() => reopened.lookupWorker('V2')).toThrow('not found');
    f.store.purge();
    expect(reopened.get("SELECT value FROM meta WHERE key='valet_number_high'").value).toBe('3');
    expect(valet(reopened).worker_number).toBe('V4');
  } finally { reopened?.close(); await f.close(); }
});

test('Valet sequence fails closed on corrupt or exhausted high-water without creating records', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    for (const high of ['-1', 'NaN', '1.5', String(Number.MAX_SAFE_INTEGER), '9007199254740992']) {
      f.store.run("INSERT INTO meta(key,value) VALUES ('valet_number_high',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", high);
      expect(() => valet(f.store)).toThrow('Valet number limit');
      expect(f.store.tasks()).toHaveLength(0);
    }
  } finally { await f.close(); }
});

test('V lookup resolves saved identity only, preserves integer APIs and does not expand manager permissions', async () => {
  const f = fixture(); f.project.kick = () => {}; const rpc = new Dispatcher(f.project);
  try {
    const first = f.project.submitManagementInstruction({ instruction: 'query only', client_request_id: 'same' }).task;
    const duplicate = f.project.submitManagementInstruction({ instruction: 'query only', client_request_id: 'same' }).task;
    expect(duplicate).toEqual(first);
    expect(first.worker_number).toBe('V1');
    expect(() => f.project.submitManagementInstruction({ instruction: 'changed', client_request_id: 'same' })).toThrow('different management definition');
    expect(() => f.project.createManagementWorker({ name: 'invalid', instruction: 'manage', signal_id: null, mode: 'persistent' })).toThrow('once only');
    const second = f.project.submitManagementInstruction({ instruction: 'next' }).task;
    expect(second.worker_number).toBe('V2');
    expect(f.project.hooksList().management_workers.map(row => row.worker_number)).toEqual(['V2','V1']);
    expect(await rpc.dispatch('worker.lookup', { number: 'V1' })).toEqual({ id: first.id, worker_number: 'V1' });
    expect((await rpc.dispatch('worker.inspect', { id: first.id })).worker_number).toBe('V1');
    expect((await f.project.taskGraph({ details: false })).nodes.some(row => row.id === first.id)).toBe(false);
    await expect(rpc.dispatch('worker.spawn', { parent: first.id, goal: 'not a developer' })).rejects.toThrow('only order/child');
    await expect(rpc.dispatch('worker.accept', { id: first.id })).rejects.toThrow('only order/child');
    await expect(rpc.dispatch('worker.reserve', { id: first.id, kind: 'merge' })).rejects.toThrow('only order/child');
    for (const number of ['V0','V01','V1-1','V1-0','V1-01','V1--1','V9007199254740992','v1','V1\n',' V1']) {
      expect(() => workerNumber(number)).toThrow('worker number');
      await expect(rpc.dispatch('worker.lookup', { number })).rejects.toThrow('worker number');
    }
    await expect(rpc.dispatch('worker.lookup', { number: 'V3' })).rejects.toThrow('not found');
    await expect(rpc.dispatch('worker.inspect', { id: 'V1' })).rejects.toThrow('positive integer');
    await expect(rpc.dispatch('management.binding_update', { id: 'V1', enabled: false, expected_revision: first.management.revision })).rejects.toThrow('positive integer');
    const token = 'valet-current';
    f.store.update(first.id, { status: 'running' }); f.store.armAgent(first.id, tokenHash(token));
    f.project.running.set(first.id, { controller: new AbortController(), token, recordId: 1 });
    f.project.beginManagementInvocation(first.id, 1);
    expect(await rpc.dispatch('worker.lookup', { number: 'V2', _token: token })).toEqual({ id: second.id, worker_number: 'V2' });
    expect(await rpc.dispatch('manager.query', { id: second.id, _token: token })).toMatchObject({ worker_number: 'V2', available_actions: [] });
    expect(await rpc.dispatch('manager.start', { id: second.id, _token: token })).toMatchObject({ status: 'skipped', target_worker_number: 'V2' });
    expect(await rpc.dispatch('manager.retry', { id: second.id, _token: token })).toMatchObject({ status: 'skipped', target_worker_number: 'V2' });
    for (const method of ['worker.spawn','worker.accept','worker.reserve','worker.message'])
      await expect(rpc.dispatch(method, { _token: token })).rejects.toThrow(/management agents can only|requires user approval/);
    f.project.running.delete(first.id);
    await expect(rpc.dispatch('worker.lookup', { number: 'V2', _token: token })).rejects.toThrow('invalid or expired');
  } finally { f.project.running.clear(); await f.close(); }
});
