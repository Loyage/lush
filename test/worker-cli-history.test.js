import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.js';
import { beginCLIHistory, finishCLIHistory, workerCLIHistory, clearWorkerCLIHistory } from '../src/core/worker-cli-history.js';

function setup() {
  const f = fixture();
  const task = f.store.create({ role: 'agent', task_kind: 'order', goal: 'history' });
  const other = f.store.create({ role: 'agent', task_kind: 'order', goal: 'other' });
  return { ...f, task, other, file: path.join(f.config.home, 'worker-cli-history', `${task.id}.json`),
    keyFile: path.join(f.config.home, 'worker-cli-history.key') };
}
const outcome = { stdout: 'OUTPUT_SECRET', stderr: 'ERROR_SECRET', exit_code: 0, signal: null,
  timed_out: false, truncated: false, duration_ms: 7, status: 'succeeded' };

test('authenticated encryption binds project and Worker; all content encrypted, owner-only paths, random nonces, durable unknown before completion', async () => {
  const f = setup(), g = setup();
  try {
    const item = beginCLIHistory(f.project, f.task.id, 'COMMAND_SECRET', '/WORKSPACE_SECRET');
    const before = fs.readFileSync(f.file, 'utf8');
    expect(workerCLIHistory(f.project, { id: f.task.id }).entries[0]).toMatchObject({ id: item.history_id, status: 'unknown', exit_code: null });
    finishCLIHistory(f.project, f.task.id, item.history_id, outcome);
    const after = fs.readFileSync(f.file, 'utf8'); expect(JSON.parse(before).nonce).not.toBe(JSON.parse(after).nonce);
    for (const secret of ['COMMAND_SECRET','WORKSPACE_SECRET','OUTPUT_SECRET','ERROR_SECRET']) expect(after).not.toContain(secret);
    for (const file of [f.file, f.keyFile]) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(f.file)).mode & 0o777).toBe(0o700);
    // A fresh daemon object has no key/cache/state dependency; interrupted executions remain unknown.
    const fresh = { config: f.config, store: f.store };
    beginCLIHistory(f.project, f.task.id, 'interrupted', '/workspace');
    expect(workerCLIHistory(fresh, { id: f.task.id }).entries.map(e => e.status)).toEqual(['succeeded','unknown']);
    expect(workerCLIHistory(f.project, { id: f.other.id }).entries).toEqual([]);
    fs.copyFileSync(f.file, path.join(path.dirname(f.file), `${f.other.id}.json`));
    expect(() => workerCLIHistory(f.project, { id: f.other.id })).toThrow('authenticated');
    beginCLIHistory(g.project, g.task.id, 'other-project', '/workspace');
    fs.copyFileSync(f.keyFile, g.keyFile); fs.copyFileSync(f.file, g.file);
    expect(() => workerCLIHistory(g.project, { id: g.task.id })).toThrow('authenticated');
  } finally { await f.close(); await g.close(); }
});

test('history lifecycle rejects missing/non-development/deleting Workers before storage access; terminal Workers need no worktree', async () => {
  const f = setup();
  try {
    const directory = path.dirname(f.file);
    for (const task_kind of ['main','owner','management','analysis']) {
      const task = f.store.create({ role: task_kind === 'management' ? 'manager' : 'agent', task_kind, goal: 'not executable CLI' });
      expect(() => workerCLIHistory(f.project, { id: task.id })).toThrow('order/child');
      expect(() => clearWorkerCLIHistory(f.project, { id: task.id })).toThrow('order/child');
      expect(() => beginCLIHistory(f.project, task.id, 'must-not-run', '/workspace')).toThrow('order/child');
    }
    expect(() => workerCLIHistory(f.project, { id: 999999 })).toThrow();
    expect(() => clearWorkerCLIHistory(f.project, { id: 999999 })).toThrow();
    expect(fs.existsSync(directory)).toBe(false); expect(fs.existsSync(f.keyFile)).toBe(false);
    const item = beginCLIHistory(f.project, f.task.id, 'keep', '/former/worktree');
    finishCLIHistory(f.project, f.task.id, item.history_id, outcome);
    f.store.update(f.task.id, { status: 'completed' });
    expect(f.store.task(f.task.id).workspace).toBeNull();
    expect(workerCLIHistory(f.project, { id: f.task.id }).entries[0].stdout).toBe(outcome.stdout);
    const child = f.store.create({ role: 'agent', task_kind: 'child', parent_id: f.other.id, goal: 'archived child' });
    f.store.update(child.id, { status: 'completed' });
    expect(workerCLIHistory(f.project, { id: child.id }).entries).toEqual([]);
    const saved = fs.readFileSync(f.file), key = fs.readFileSync(f.keyFile);
    f.project.workerDeleteIds = new Set([f.task.id]);
    const rejected = () => {
      expect(() => workerCLIHistory(f.project, { id: f.task.id })).toThrow('deletion is in progress');
      expect(() => clearWorkerCLIHistory(f.project, { id: f.task.id })).toThrow('deletion is in progress');
      expect(() => beginCLIHistory(f.project, f.task.id, 'must-not-run', '/workspace')).toThrow('deletion is in progress');
      expect(() => finishCLIHistory(f.project, f.task.id, item.history_id, outcome)).toThrow('deletion is in progress');
    };
    rejected(); expect(fs.readFileSync(f.file)).toEqual(saved);
    expect(workerCLIHistory(f.project, { id: f.other.id }).entries).toEqual([]);
    fs.unlinkSync(f.file); rejected(); expect(fs.existsSync(f.file)).toBe(false);
    expect(fs.readFileSync(f.keyFile)).toEqual(key);
    f.project.workerDeleteIds = null; fs.writeFileSync(f.file, saved, { mode: 0o600 });
    expect(clearWorkerCLIHistory(f.project, { id: f.task.id })).toEqual({ cleared: true });
    expect(clearWorkerCLIHistory(f.project, { id: child.id })).toEqual({ cleared: true });
  } finally { f.project.workerDeleteIds = null; await f.close(); }
});

test('retention, strict cursors, byte pagination including JSON escaping, clear high-water and in-flight clear refusal', async () => {
  const f = setup();
  try {
    for (let index = 0; index < 105; index++) beginCLIHistory(f.project, f.task.id, `command-${index}`, '/workspace');
    const latest = workerCLIHistory(f.project, { id: f.task.id });
    expect(latest.entries).toHaveLength(10); expect(latest.entries.map(e => e.id)).toEqual(Array.from({ length: 10 }, (_, i) => 96 + i));
    const ids = []; let before;
    do {
      const page = workerCLIHistory(f.project, { id: f.task.id, limit: 20, ...(before ? { before } : {}) });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(900000);
      expect(page.before).toBe(page.entries[0]?.id ?? null); ids.unshift(...page.entries.map(e => e.id));
      before = page.has_more ? page.before : null;
    } while (before);
    expect(ids).toEqual(Array.from({ length: 100 }, (_, i) => i + 6));
    expect(clearWorkerCLIHistory(f.project, { id: f.task.id })).toEqual({ cleared: true });
    expect(workerCLIHistory(f.project, { id: f.task.id })).toEqual({ entries: [], before: null, has_more: false });
    const huge = '\u0000'.repeat(65536);
    for (let index = 0; index < 4; index++) {
      const item = beginCLIHistory(f.project, f.task.id, `escape-${index}`, '/workspace');
      finishCLIHistory(f.project, f.task.id, item.history_id, { ...outcome, stdout: huge, stderr: '' });
    }
    const page = workerCLIHistory(f.project, { id: f.task.id, limit: 20 });
    expect(page.entries.map(e => e.id)).toEqual([108,109]); expect(page.before).toBe(108); expect(page.has_more).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(900000);
    expect(workerCLIHistory(f.project, { id: f.task.id, before: page.before }).entries.map(e => e.id)).toEqual([106,107]);
    f.project.cliRunning = new Map([['lease', { taskId: f.task.id }]]);
    expect(() => clearWorkerCLIHistory(f.project, { id: f.task.id })).toThrow('in progress');
    f.project.cliRunning.clear();
    for (const params of [{ id: f.task.id, limit: 21 }, { id: f.task.id, limit: 0 }, { id: f.task.id, before: 0 }, { id: f.task.id, before: '3' }])
      expect(() => workerCLIHistory(f.project, params)).toThrow();
  } finally { await f.close(); }
});

test('damaged data, missing/wrong key, unsafe permissions, hardlinks and symlinks fail closed without overwriting history', async () => {
  const f = setup();
  try {
    beginCLIHistory(f.project, f.task.id, 'preserve-me', '/workspace');
    const data = fs.readFileSync(f.file), key = fs.readFileSync(f.keyFile);
    const rejects = () => {
      expect(() => workerCLIHistory(f.project, { id: f.task.id })).toThrow();
      expect(() => beginCLIHistory(f.project, f.task.id, 'must-not-run', '/workspace')).toThrow();
      expect(() => clearWorkerCLIHistory(f.project, { id: f.task.id })).toThrow();
    };
    fs.unlinkSync(f.keyFile); rejects(); expect(fs.readFileSync(f.file)).toEqual(data); expect(fs.existsSync(f.keyFile)).toBe(false);
    fs.writeFileSync(f.keyFile, Buffer.alloc(32), { mode: 0o600 }); rejects(); expect(fs.readFileSync(f.file)).toEqual(data);
    fs.writeFileSync(f.keyFile, key); fs.writeFileSync(f.file, 'damage'); rejects(); expect(fs.readFileSync(f.file, 'utf8')).toBe('damage');
    fs.writeFileSync(f.file, data); fs.chmodSync(f.file, 0o644); rejects(); fs.chmodSync(f.file, 0o600);
    const outside = path.join(f.root, 'outside'); fs.writeFileSync(outside, data, { mode: 0o600 });
    fs.unlinkSync(f.file); fs.symlinkSync(outside, f.file); rejects(); expect(fs.readFileSync(outside)).toEqual(data);
    fs.unlinkSync(f.file); fs.linkSync(outside, f.file); rejects(); fs.unlinkSync(f.file); fs.writeFileSync(f.file, data, { mode: 0o600 });
    const keyCopy = f.keyFile + '.saved'; fs.renameSync(f.keyFile, keyCopy); fs.symlinkSync(keyCopy, f.keyFile); rejects();
    fs.unlinkSync(f.keyFile); fs.renameSync(keyCopy, f.keyFile);
    const dir = path.dirname(f.file), saved = dir + '.saved'; fs.renameSync(dir, saved); fs.symlinkSync(saved, dir); rejects();
    fs.unlinkSync(dir); fs.renameSync(saved, dir);
    expect(workerCLIHistory(f.project, { id: f.task.id }).entries[0].command).toBe('preserve-me');
  } finally { await f.close(); }
});
