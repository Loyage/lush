import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';

test('summary Worker graph keeps lifecycle/queue facts without Git or session reads; full default remains compatible', async () => {
  const f = fixture(); await repo(f.root);
  try {
    const { task } = await f.project.order('快速结构', 'main', [], null, false);
    const before = f.store.get('SELECT count(*) AS n FROM events').n;
    const originalGit = f.project.workspaces.gitOutput;
    const originalRead = fs.createReadStream;
    let gitReads = 0, sessionReads = 0;
    f.project.workspaces.gitOutput = async function(...args) { gitReads++; return originalGit.apply(this, args); };
    fs.createReadStream = function(...args) { sessionReads++; return originalRead.apply(this, args); };
    try {
      const sessions = path.join(f.config.home, 'sessions'); fs.mkdirSync(sessions, { recursive: true });
      fs.writeFileSync(path.join(sessions, `now_lush-task-${task.id}.jsonl`), JSON.stringify({ type: 'message',
        message: { role: 'assistant', usage: { input: 10, output: 2, cost: { total: 0.1 } } } }) + '\n');
      const dispatcher = new Dispatcher(f.project, { request() {} });
      const summary = await dispatcher.dispatch('worker.graph', { details: false });
      expect(summary.details_pending).toBe(true);
      expect(summary.nodes.find(n => n.id === task.id)).toMatchObject({ title: '快速结构', status: 'paused',
        details_pending: true, resources: null, branch_info: { current: null, relation: null, diagnostics: null, archivable: null } });
      expect(summary.nodes.find(n => n.id === task.id).merge_readiness).toBeDefined();
      expect(summary.edges).toContainEqual({ from: task.parent_id, to: task.id });
      expect(gitReads).toBe(0); expect(sessionReads).toBe(0);
      const full = await dispatcher.dispatch('worker.graph', {});
      expect(full.details_pending).toBeUndefined();
      expect(full.nodes.find(n => n.id === task.id).branch_info.diagnostics.working_tree.status).toBe('clean');
      expect(full.nodes.find(n => n.id === task.id).resources.own.input).toBe(10);
      expect(gitReads).toBeGreaterThan(0); expect(sessionReads).toBe(1);
      expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(before);
      await expect(dispatcher.dispatch('worker.graph', { details: 'false' })).rejects.toThrow('details must be boolean');
    } finally { f.project.workspaces.gitOutput = originalGit; fs.createReadStream = originalRead; }
  } finally { await f.close(); }
});
