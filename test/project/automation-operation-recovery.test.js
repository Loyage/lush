import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo } from '../helpers.js';
import { Project } from '../../src/core/project.js';

async function waiting() {
  const f = fixture(); f.project.stopping = true; f.project.kick = () => {};
  try {
    await repo(f.root);
    const { task } = await f.project.order('safe no-change answer', 'main', [], null, false);
    await f.project.setTaskCompletion(task.id, 'accept', f.project.taskHooks(task.id).revision);
    f.store.update(task.id, { status: 'waiting' });
    await f.project.settleQueuedMerge(task.id);
    fs.writeFileSync(path.join(task.workspace, 'keep.txt'), 'PRIVATE_SECRET');
    f.project.stopping = false; await f.project.runTaskCompletion(task.id); f.project.stopping = true;
    return { ...f, task };
  } catch (error) { await f.close(); throw error; }
}
const operation = (project, task) => project.taskHooks(task.id).mounts.find(row => row.id === 'auto-accept').operation;

test('public lifecycle methods preserve asynchronous rejection through the internal tool dispatcher', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    await expect(f.project.acceptTask(-1)).rejects.toThrow();
    await expect(f.project.requestTaskMerge(-1)).rejects.toThrow();
    await expect(f.project.settleQueuedMerge(-1)).rejects.toThrow();
  } finally { await f.close(); }
});

test('restart resumes only the exact unstarted acceptance submission and keeps operation identity', async () => {
  const f = await waiting();
  const restarted = new Project(f.config, f.store); restarted.stopping = true; restarted.kick = () => {};
  try {
    const before = operation(f.project, f.task);
    expect(before.status).toBe('waiting');
    restarted.recoverTaskCompletion();
    expect(operation(restarted, f.task)).toEqual(before);
    fs.unlinkSync(path.join(f.task.workspace, 'keep.txt'));
    restarted.stopping = false; await restarted.runTaskCompletion(f.task.id);
    expect(operation(restarted, f.task)).toMatchObject({ id: before.id, status: 'succeeded' });
    expect(f.store.history(f.task.id).filter(row => row.type === 'completion.execution_submitted')).toHaveLength(1);
    expect(f.store.history(f.task.id).filter(row => row.type === 'task.accepted')).toHaveLength(1);
  } finally { await restarted.shutdown(); await f.close(); }
});

test('manual tool acceptance after a preflight wait exposes the actual manual receipt, not invented automatic success', async () => {
  const f = await waiting();
  try {
    const before = operation(f.project, f.task);
    fs.unlinkSync(path.join(f.task.workspace, 'keep.txt'));
    await f.project.acceptTask(f.task.id);
    const after = operation(f.project, f.task);
    expect(after).toMatchObject({ tool: 'accept_worker', status: 'succeeded' });
    expect(after.id).not.toBe(before.id);
    expect(f.store.history(f.task.id).filter(row => row.type === 'completion.execution_started')).toHaveLength(0);
    expect(JSON.parse(f.store.task(f.task.id).auto_merge).completion.executions.accept.status).toBe('waiting');
  } finally { await f.close(); }
});

test('safe operation projection rejects mismatched authorization and secret-shaped status/timestamps', async () => {
  const f = await waiting();
  try {
    let config = JSON.parse(f.store.task(f.task.id).auto_merge);
    config.completion.executions.accept.status = 'PRIVATE_SECRET';
    config.completion.executions.accept.created_at = 'PRIVATE_SECRET';
    config.completion.executions.accept.finished_at = 'PRIVATE_SECRET';
    config.completion.executions.accept.error = 'PRIVATE_SECRET';
    f.store.update(f.task.id, { auto_merge: JSON.stringify(config) });
    const result = operation(f.project, f.task);
    expect(result.status).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SECRET');
    config.completion.executions.accept.authorization = 'wrong authorization';
    f.store.update(f.task.id, { auto_merge: JSON.stringify(config) });
    expect(operation(f.project, f.task)).toBeNull();
  } finally { await f.close(); }
});
