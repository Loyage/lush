import { test, expect } from 'bun:test';
import { managementFixture } from './runner-management-fixture.js';
import { repo } from './helpers.js';

test('actual CLI/RPC persist an explicit local node through buffered input', async () => {
  const f = await managementFixture(); f.project.stopping = true;
  try {
    await repo(f.root);
    const result = await f.cli(['order', 'goal', '--runner-node', 'local', '--buffer']);
    expect(result).toMatchObject({ code: 0, err: '' });
    const returned = JSON.parse(result.out), draft = f.store.draft(returned.draft_id ?? returned.id);
    expect(JSON.parse(draft.input_options).runner_node_id).toBe('local');
    expect(returned.runner_node_id).toBe('local'); expect(returned.task).toBeUndefined();
    expect(f.store.all("SELECT id FROM tasks WHERE task_kind='order'")).toEqual([]);
    expect(f.connections()).toBe(0);
  } finally { await f.close(); }
});
