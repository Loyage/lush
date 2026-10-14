import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from 'bun:test';
import { fixture, repo, gate } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';

test('returned frozen lifecycle action blocks new creation and deletion until explicitly revoked, never starting the target', async () => {
  let f;
  f = fixture({ run({ task, api }) { if (task.role === 'manager') api.requestManagementAction(task.id, 'start', f.target.id); return 'submitted'; } });
  try {
    f.project.kick = () => {}; await repo(f.root);
    f.target = (await f.project.order('paused target', 'main', [], null, false)).task;
    const original = f.project.branchFreeze.bind(f.project);
    f.project.branchFreeze = branch => branch === f.target.branch ? { branch, reason: 'frozen' } : original(branch);
    const manager = f.project.submitManagementInstruction({ instruction: 'start target' }).task;
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    expect(f.project.managementView(manager.id).pending_signal.actions[0].status).toBe('waiting');
    expect(() => f.project.submitManagementInstruction({ instruction: 'must wait' })).toThrow('当前项目已有管家');
    expect((await f.project.deleteTaskPreview(manager.id)).can_delete).toBe(false);
    f.project.cancel(manager.id);
    f.project.branchFreeze = original; f.project.drainManagementActions();
    expect(f.store.task(f.target.id).status).toBe('paused');
    expect(f.project.managementView(manager.id).last_execution.actions[0].status).toBe('skipped');
    expect((await f.project.deleteTaskPreview(manager.id)).can_delete).toBe(true);
    expect(f.project.submitManagementInstruction({ instruction: 'released' }).task.worker_number).toBe('V2');
  } finally { await f.close(); }
});

test('Provider return is not exit: asynchronous invocation cleanup retains ownership after stop', async () => {
  const cleanup = gate(), release = gate(); let returned = false, intercepted = false;
  const f = fixture({ run() { returned = true; return 'provider returned'; } });
  try {
    f.project.kick = () => {}; await repo(f.root);
    const close = f.project.workspaces.closeOwnedBranch.bind(f.project.workspaces);
    f.project.workspaces.closeOwnedBranch = async owned => {
      if (returned && !intercepted) { intercepted = true; cleanup.resolve(); await release.promise; }
      return close(owned);
    };
    const manager = f.project.submitManagementInstruction({ instruction: 'cleanup ownership' }).task;
    f.project.pump(); await cleanup.promise;
    f.project.cancel(manager.id);
    expect(() => f.project.submitManagementInstruction({ instruction: 'cannot overlap cleanup' })).toThrow('当前项目已有管家');
    expect((await f.project.deleteTaskPreview(manager.id)).blockers.join(' ')).toContain('exiting');
    release.resolve(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    expect((await f.project.deleteTaskPreview(manager.id)).can_delete).toBe(true);
  } finally { release.resolve(); await f.close(); }
});

test('management deletion refuses shared paths, links and Git-looking directories, including force mode', async () => {
  const f = fixture();
  try {
    f.project.kick = () => {}; await repo(f.root);
    const manager = f.project.submitManagementInstruction({ instruction: 'safe directory' }).task;
    f.project.cancel(manager.id);
    const directory = path.join(f.config.home, 'management', String(manager.id));
    fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, '.git'), 'gitdir: /outside-repository');
    for (const force of [false, true]) expect((await f.project.deleteTaskPreview(manager.id, { force })).can_delete).toBe(false);
    fs.rmSync(path.join(directory, '.git'));
    const outsider = f.store.create({ role: 'agent', task_kind: 'child', goal: 'shared resource owner' });
    f.store.update(outsider.id, { workspace: directory });
    expect((await f.project.deleteTaskPreview(manager.id)).blockers.join(' ')).toContain('shared');
    f.store.update(outsider.id, { workspace: null }); fs.rmdirSync(directory);
    fs.symlinkSync(f.root, directory);
    expect((await f.project.deleteTaskPreview(manager.id)).blockers.join(' ')).toContain('symlink');
    fs.unlinkSync(directory);
    expect((await f.project.deleteTaskPreview(manager.id)).can_delete).toBe(true);
  } finally { await f.close(); }
});

test('cancel of an already completed Valet is idempotent and does not expand Agent delete/accept permissions', async () => {
  let token;
  const f = fixture({ run(args) { token = args.token; return 'done'; } });
  try {
    f.project.kick = () => {}; await repo(f.root);
    const rpc = new Dispatcher(f.project, { isRequested: () => false, request() {} }, {});
    const manager = f.project.submitManagementInstruction({ instruction: 'once' }).task;
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    const before = f.store.task(manager.id);
    f.project.cancel(manager.id); expect(f.store.task(manager.id)).toEqual(before);
    for (const method of ['worker.delete_preview', 'worker.delete', 'worker.accept'])
      await expect(rpc.dispatch(method, { id: manager.id, _token: token })).rejects.toThrow();
  } finally { await f.close(); }
});
