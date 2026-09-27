import { test, expect } from 'bun:test';
import { fixture, repo, until } from '../helpers.js';

/** planner 只写 spec 队列；测试里用它造一个能直接派活的非 planner AP。 */
function host(f, { role = 'coordinator', goal = 'host', input_id = null } = {}) {
  const ap = f.store.create({ input_id, role, goal });
  f.store.update(ap.id, { status: 'waiting' });
  return ap;
}

test('recovery does not replay running aps or interrupted merges', async () => {
  const f = fixture(); await repo(f.root);
  try {
    f.project.stopping = true;
    const root = host(f, { goal: 'root' });
    const child = f.project.spawn(root.id,'child','research');
    f.store.update(root.id,{status:'running',integration:'merging'});
    f.store.armAgent(root.id, 'deadbeef');
    f.project.recover();
    expect(f.store.ap(root.id).status).toBe('failed');
    expect(f.store.ap(child.id).status).toBe('cancelled');
    expect(f.store.ap(root.id).integration).toBe('review');
    expect(f.store.ap(root.id).agent_token_hash).toBeNull();
  } finally { await f.close(); }
});

test('recovery repairs a committed inbox message whose wake-up was interrupted', async () => {
  const f = fixture(); await repo(f.root);
  try {
    f.project.stopping = true;
    const root = (await f.project.submit('waiting root')).ap;
    f.store.update(root.id,{status:'waiting'});
    f.store.message(root.id,'child result committed before daemon died');
    f.project.recover();
    expect(f.store.ap(root.id).status).toBe('queued');
    expect(f.store.unread(root.id)).toHaveLength(1);
  } finally { await f.close(); }
});
