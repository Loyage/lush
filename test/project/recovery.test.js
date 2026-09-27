import { test, expect } from 'bun:test';
import { fixture, repo, until } from '../helpers.js';

test('recovery does not replay running tasks or interrupted merges', async () => {
  const f = fixture(); await repo(f.root);
  try {
    f.project.stopping = true;
    const root = (await f.project.say('root')).task;
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
    const root = (await f.project.say('waiting root')).task;
    f.store.update(root.id,{status:'waiting'});
    f.store.message(root.id,'child result committed before daemon died');
    f.project.recover();
    expect(f.store.task(root.id).status).toBe('queued');
    expect(f.store.unread(root.id)).toHaveLength(1);
  } finally { await f.close(); }
});
