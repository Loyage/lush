import { test, expect } from 'bun:test';
import { fixture, repo, until } from '../helpers.js';

test('recovery closes orphan Runs once, including parked and legacy records, without fabricating an exit time', async () => {
  const f = fixture(); await repo(f.root); f.project.stopping = true;
  try {
    const root = (await f.project.order('interrupted')).task;
    f.store.update(root.id, { status: 'running' });
    const running = f.store.startRun(root);
    const legacy = ['queued', 'waiting', 'awaiting', 'paused', 'completed'].map(status => {
      const task = f.store.create({ role: 'research', goal: status });
      f.store.update(task.id, { status });
      return { task, status, run: f.store.startRun(task) };
    });
    const complete = f.store.startRun(root);
    f.store.finishRun(complete.id, 'completed', { result: 'prior result' });
    const previous = f.store.runsForTask(root.id).at(-1);
    f.project.recover();
    expect(f.store.task(root.id).status).toBe('failed');
    for (const entry of [{ task: root, run: running }, ...legacy]) {
      const run = f.store.get('SELECT * FROM agent_runs WHERE id=?', entry.run.id);
      expect(run.status).toBe('failed');
      expect(run.ended_at).toBeTruthy();
      expect(run.error).toContain('recovery observation, not actual process exit');
      if (entry.status) expect(f.store.task(entry.task.id).status).toBe(entry.status);
      const data = JSON.parse(f.store.get("SELECT data FROM events WHERE task_id=? AND type='invocation.recovered'", entry.task.id).data);
      expect(data).toEqual({ run_id: run.id, observed_at: run.ended_at, actual_exit_at: null });
    }
    expect(f.store.get('SELECT * FROM agent_runs WHERE id=?', complete.id)).toEqual(previous);
    const closed = f.store.all('SELECT * FROM agent_runs ORDER BY id');
    f.project.recover();
    expect(f.store.all('SELECT * FROM agent_runs ORDER BY id')).toEqual(closed);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='invocation.recovered'").n).toBe(6);
    expect(f.store.get('SELECT count(*) AS n FROM artifacts').n).toBe(0);
  } finally { await f.close(); }
});

test('Run creation rolls back if Worker admission fails', async () => {
  const f = fixture(); await repo(f.root); f.project.stopping = true;
  try {
    const task = (await f.project.order('atomic admission')).task;
    const update = f.store.update.bind(f.store);
    f.store.update = (id, patch) => {
      if (patch.status === 'running') throw new Error('injected admission failure');
      return update(id, patch);
    };
    await f.project.invoke(task.id, { controller: new AbortController(), token: 'test', recordId: null });
    expect(f.store.runsForTask(task.id)).toEqual([]);
    expect(f.store.task(task.id)).toMatchObject({ status: 'failed', calls: 0, agent_wakes: 0,
      error: 'injected admission failure' });
  } finally { await f.close(); }
});

test('recovery does not replay running tasks or interrupted merges', async () => {
  const f = fixture(); await repo(f.root);
  try {
    f.project.stopping = true;
    const root = (await f.project.order('root')).task;
    const child = await f.project.spawn(root.id,'child', undefined, [], 'child');
    f.store.update(root.id,{status:'running',integration:'merging'});
    f.store.armAgent(root.id, 'deadbeef');
    f.project.recover();
    expect(f.store.task(root.id).status).toBe('failed');
    expect(f.store.task(child.id).status).toBe('cancelled');
    expect(f.store.task(root.id).integration).toBe('review');
    expect(f.store.task(root.id).agent_token_hash).toBeNull();
  } finally { await f.close(); }
});

test('recovery repairs a committed inbox message whose wake-up was interrupted', async () => {
  const f = fixture(); await repo(f.root);
  try {
    f.project.stopping = true;
    const root = (await f.project.order('waiting root')).task;
    f.store.update(root.id,{status:'waiting'});
    f.store.message(root.id,'child result committed before daemon died');
    f.project.recover();
    expect(f.store.task(root.id).status).toBe('queued');
    expect(f.store.unread(root.id)).toHaveLength(1);
  } finally { await f.close(); }
});
