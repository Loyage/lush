import { repo } from './helpers.js';

/** Real isolated Git worktrees with the terminal-notification acceptance trap. No Provider invocation. */
export async function acceptanceFixture(f) {
  f.project.kick = () => {};
  await repo(f.root);
  const parent = (await f.project.order('accept reviewed work')).task;
  await f.project.workspaces.ensure(parent);
  f.store.update(parent.id, { status: 'waiting' });
  const child = await f.project.spawn(parent.id, 'already delivered UI');
  await f.project.workspaces.ensure(child);
  const leaf = await f.project.spawn(child.id, 'already delivered component');
  await f.project.workspaces.ensure(leaf);
  for (const row of [parent, child, leaf]) await f.project.workspaces.finish(f.store.task(row.id));
  const signal = f.project.sendTaskSignal(leaf.id, child.id, 'child.cancelled', `child:${leaf.id}:settlement:test`,
    { error: 'worker invocation limit reached' });
  f.store.update(parent.id, { status: 'awaiting_acceptance', reservation: null });
  for (const row of [child, leaf]) f.store.update(row.id, { status: 'cancelled', error: 'worker invocation limit reached', reservation: null });
  return { parent: f.store.task(parent.id), child: f.store.task(child.id), leaf: f.store.task(leaf.id), signal };
}
