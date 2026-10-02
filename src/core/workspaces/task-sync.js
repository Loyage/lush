import fs from 'node:fs';
import { check, LushError } from '../types.js';

const oid = value => typeof value === 'string' && /^[0-9a-f]{40,64}$/.test(value);
const bookingOf = task => task.reservation ? JSON.parse(task.reservation) : null;

/** Hold the fixed parent ref without writing it. Git's ff-only writes the source with its own ref CAS. */
async function withParentLock(workspaces, branch, commit, action) {
  const proc = Bun.spawn(['git', '-C', workspaces.config.project, 'update-ref', '--stdin'], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...workspaces.config.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const errorText = new Response(proc.stderr).text();
  const reader = proc.stdout.getReader();
  try {
    proc.stdin.write(`start\nverify refs/heads/${branch} ${commit}\nprepare\n`);
    await proc.stdin.flush();
    let output = '';
    while (!output.includes('prepare: ok\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new LushError(`parent ref moved or locked: ${await errorText}`);
      output += new TextDecoder().decode(chunk.value);
    }
    return await action();
  } finally {
    try { proc.stdin.write('abort\n'); proc.stdin.end(); } catch { /* Git already rejected the transaction. */ }
    while (!(await reader.read()).done) { /* drain protocol */ }
    await proc.exited;
    await errorText;
  }
}

export const methods = {
  async taskSyncCheckout(task, source) {
    const workspace = await this.workspaceForBranch(task.branch);
    check(workspace && task.workspace && fs.realpathSync(workspace) === fs.realpathSync(task.workspace),
      'Worker branch must remain checked out in its own worktree');
    check(fs.realpathSync(await this.git(workspace, 'rev-parse', '--show-toplevel')) === fs.realpathSync(workspace),
      'Worker workspace is not a worktree root');
    await this.assertCleanBranches([task.branch]); // also detects detached rebases and all Git intermediate states
    await this.clean(workspace);
    check(await this.git(workspace, 'symbolic-ref', '--quiet', 'HEAD') === `refs/heads/${task.branch}`
      && await this.git(workspace, 'rev-parse', 'HEAD') === source, 'Worker checkout moved during synchronization');
    return workspace;
  },

  /** Squash receipts establish an equivalent-tree base, not a fabricated Git ancestor. */
  async taskSyncBase(task, source, parent) {
    const project = this.config.project;
    const receipt = this.store.get("SELECT data FROM events WHERE task_id=? AND type='task.merge_integrated' ORDER BY id DESC LIMIT 1", task.id);
    let landed = receipt ? JSON.parse(receipt.data) : null;
    if (!landed) {
      const booking = bookingOf(task);
      if (booking?.status === 'integrated' && booking.commit && booking.landed_commit)
        landed = { source_commit: booking.commit, commit: booking.landed_commit, parent_id: booking.parent_id };
    }
    if (landed) {
      check(oid(landed.source_commit) && oid(landed.commit) && landed.parent_id === task.parent_id,
        'delivery receipt does not match the current direct parent');
      check(await this.isAncestor(project, landed.source_commit, source)
        && await this.isAncestor(project, landed.commit, parent), 'delivery source/parent history no longer contains its fixed receipt');
      check(await this.git(project, 'rev-parse', `${landed.source_commit}^{tree}`)
        === await this.git(project, 'rev-parse', `${landed.commit}^{tree}`), 'delivery receipt trees differ');
      // A later successful sync recorded a real parent ancestor. Use that newer baseline;
      // otherwise replay only changes since the delivered source, never the old squash delta.
      if (task.iteration_base_commit && await this.isAncestor(project, landed.commit, task.iteration_base_commit)
        && await this.isAncestor(project, task.iteration_base_commit, source)
        && await this.isAncestor(project, task.iteration_base_commit, parent)) return task.iteration_base_commit;
      return landed.source_commit;
    }
    if (task.iteration_base_commit) {
      check(oid(task.iteration_base_commit)
        && await this.isAncestor(project, task.iteration_base_commit, source)
        && await this.isAncestor(project, task.iteration_base_commit, parent), 'iteration baseline is no longer a true common ancestor');
    }
    // Respect real, possibly multiple, merge bases in ordinary history.
    return null;
  },

  /** Pure object merge first; content conflicts never touch the user's index/worktree. Caller owns the Git queue. */
  async syncTaskParentUnsafe(task, source, parent, recheck = () => {}) {
    const project = this.config.project;
    const record = this.store.branch(task.branch);
    check(record?.status === 'active' && record.task_id === task.id && record.parent_relation === 'recorded'
      && record.parent === task.target_branch, 'Worker has no matching active direct-parent branch record');
    check(oid(source) && oid(parent), 'synchronization requires fixed commits');
    const readRef = branch => this.git(project, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`);
    const verify = async () => {
      recheck();
      check(await readRef(task.branch) === source && await readRef(record.parent) === parent,
        'source/parent moved during synchronization; refresh and retry');
      await this.assertCleanBranches([task.branch, record.parent]);
      await this.taskSyncCheckout(task, source);
    };
    await verify();
    const base = await this.taskSyncBase(task, source, parent);
    let tree;
    if (await this.isAncestor(project, parent, source)) tree = await this.git(project, 'rev-parse', `${source}^{tree}`);
    else {
      const args = ['merge-tree', '--write-tree', '--messages', ...(base ? [`--merge-base=${base}`] : []), source, parent];
      const proc = Bun.spawn(['git', '-C', project, ...args], {
        stdout: 'pipe', stderr: 'pipe', env: { ...this.config.env, GIT_TERMINAL_PROMPT: '0' },
      });
      const [output, error, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (code === 1 && oid(output.split('\n')[0])) {
        await verify();
        return { synced: false, conflict: true, source_commit: source, parent_commit: parent,
          base_commit: base, reason: output.slice(0, 16000) };
      }
      check(code === 0, `Git three-way synchronization failed: ${error || output}`);
      tree = output.split('\n')[0];
      check(oid(tree), 'Git did not produce a valid merged tree');
    }
    let commit = source;
    if (!await this.isAncestor(project, parent, source)) {
      // Never discard source history, including commits previously delivered through squash.
      commit = await this.git(project, '-c', 'user.name=Lush', '-c', 'user.email=lush@localhost',
        'commit-tree', tree, '-p', source, '-p', parent, '-m', `Sync task #${task.id} with parent ${parent}`);
    }
    await withParentLock(this, record.parent, parent, async () => {
      await verify();
      if (commit !== source) await this.git(task.workspace, '-c', 'core.hooksPath=/dev/null',
        'merge', '--ff-only', '--no-edit', commit);
      check(await readRef(task.branch) === commit, 'source changed during synchronization; inspect the worktree');
      await this.taskSyncCheckout(task, commit);
    });
    return { synced: commit !== source, conflict: false, source_commit: source, parent_commit: parent,
      head_commit: commit, base_commit: base,
      integration: tree === await this.git(project, 'rev-parse', `${parent}^{tree}`) ? 'merged' : 'pending' };
  },
};
