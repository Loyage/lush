import { test, expect } from 'bun:test';
import { git } from '../helpers.js';
import { setup } from './harness.js';
import { Dispatcher } from '../../src/rpc/protocol.js';

test('inspect reports live parent distance through divergence and sync without changing stored tips or refs', async () => {
  const f = await setup();
  try {
    const rpc = new Dispatcher(f.project);
    const read = async () => (await rpc.dispatch('worker.inspect', { id: f.task.id })).parent_relation;
    const stored = f.store.task(f.task.id);
    expect(await read()).toEqual({ ahead: 0, behind: 0 });
    await git(f.task.workspace, 'commit', '--allow-empty', '-m', 'worker advances');
    expect(await read()).toEqual({ ahead: 1, behind: 0 });
    await git(f.root, 'commit', '--allow-empty', '-m', 'parent advances');
    await git(f.root, 'commit', '--allow-empty', '-m', 'parent advances again');
    // A same-name tag must not shadow the local parent branch.
    await git(f.root, 'tag', 'main', stored.base_commit);
    const source = await git(f.root, 'rev-parse', `refs/heads/${f.task.branch}`);
    const parent = await git(f.root, 'rev-parse', 'refs/heads/main');
    expect(await read()).toEqual({ ahead: 1, behind: 2 });
    expect(f.store.task(f.task.id)).toEqual(stored);
    expect(await git(f.root, 'rev-parse', `refs/heads/${f.task.branch}`)).toBe(source);
    expect(await git(f.root, 'rev-parse', 'refs/heads/main')).toBe(parent);
    await git(f.task.workspace, 'merge', '--no-edit', parent);
    expect(await read()).toEqual({ ahead: 2, behind: 0 });
    // The original fork remains old; its behind count is not the live distance.
    expect(f.store.task(f.task.id).base_commit).toBe(stored.base_commit);
    await git(f.root, 'commit', '--allow-empty', '-m', 'parent moves after sync');
    expect(await read()).toEqual({ ahead: 2, behind: 1 });
  } finally { await f.close(); }
});

test('distance uses a child Worker direct parent, not main', async () => {
  const f = await setup();
  try {
    const child = await f.project.spawn(f.task.id, 'child');
    await git(f.root, 'commit', '--allow-empty', '-m', 'unrelated main advancement');
    const rpc = new Dispatcher(f.project);
    const read = async () => (await rpc.dispatch('worker.inspect', { id: child.id })).parent_relation;
    expect(await read()).toEqual({ ahead: 0, behind: 0 });
    await git(f.task.workspace, 'commit', '--allow-empty', '-m', 'direct parent advancement');
    expect(await read()).toEqual({ ahead: 0, behind: 1 });
  } finally { await f.close(); }
});

test('missing refs, failed Git and malformed counts are unknown rather than zero', async () => {
  const f = await setup();
  try {
    const ws = f.project.workspaces;
    const unknown = { ahead: null, behind: null };
    expect(await ws.parentRelation({ ...f.task, branch: null })).toEqual(unknown);
    expect(await ws.parentRelation({ ...f.task, target_branch: null })).toEqual(unknown);
    expect(await ws.parentRelation({ ...f.task, branch: 'missing' })).toEqual(unknown);
    expect(await ws.parentRelation({ ...f.task, target_branch: 'missing' })).toEqual(unknown);
    const original = ws.git.bind(ws);
    try {
      for (const output of [null, '', '1', '1 NaN', '-1 0', '1 2 3', '1 9007199254740992']) {
        ws.git = async (dir, ...args) => {
          if (args[0] !== 'rev-list') return original(dir, ...args);
          if (output === null) throw new Error('unavailable');
          return output;
        };
        expect(await ws.parentRelation(f.task)).toEqual(unknown);
      }
    } finally { ws.git = original; }
  } finally { await f.close(); }
});
