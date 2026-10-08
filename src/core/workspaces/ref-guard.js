import { check } from '../types.js';

const branchRef = branch => `refs/heads/${branch}`;
const MAX_TRANSITIONS = 4096;

/** Invocation-scoped evidence, not a Git sandbox or proof of which OS process wrote a ref. */
export const methods = {
  async readGuardRef(ref) {
    return this.git(this.config.project, 'rev-parse', '--verify', ref).catch(() => null);
  },

  async watchBranch(branch) {
    const watch = { ref: branchRef(branch), transitions: [], overflow: false };
    this.refWatches.add(watch);
    try {
      // Split an already active owner's window at this exact snapshot. Otherwise an
      // A→C owner observation could not explain a child starting at intermediate tip B.
      const owner = [...this.refOwners].find(owner => owner.ref === watch.ref);
      watch.baseline = owner ? await this.checkpointOwnedBranch(owner) : await this.readGuardRef(watch.ref);
      if (watch.baseline === undefined) watch.baseline = await this.readGuardRef(watch.ref);
      return watch;
    }
    catch (error) { this.refWatches.delete(watch); throw error; }
  },

  unwatchBranch(watch) { this.refWatches.delete(watch); },

  noteRefTransition(ref, before, after, source) {
    if (before === after) return;
    for (const watch of this.refWatches) if (watch.ref === ref) {
      if (watch.transitions.length >= MAX_TRANSITIONS) watch.overflow = true;
      else watch.transitions.push({ before, after, source });
    }
  },

  /** Register BEFORE the write; readers wait for the receipt, not merely for the new Git tip. */
  async trackRefWrite(ref, action, expected = null) {
    const pending = this.refWrites.get(ref) ?? new Set();
    this.refWrites.set(ref, pending);
    const operation = (async () => {
      const before = expected ? expected.before : await this.readGuardRef(ref);
      const result = await action(); // Failed commands never authorize a transition.
      const after = expected ? expected.after : await this.readGuardRef(ref);
      this.noteRefTransition(ref, before, after, { kind: 'daemon' });
      return result;
    })();
    pending.add(operation);
    try { return await operation; }
    finally { pending.delete(operation); if (!pending.size) this.refWrites.delete(ref); }
  },

  async observeOwnedBranch(task, cwd, runId) {
    if (!task.branch || task.workspace !== cwd || !['order', 'say', 'child'].includes(task.task_kind)) return null;
    const ref = branchRef(task.branch);
    check(await this.git(cwd, 'symbolic-ref', '--quiet', 'HEAD') === ref, 'Worker branch ownership changed before invocation');
    const owner = { ref, branch: task.branch, workspace: cwd, taskId: task.id, runId,
      head: await this.readGuardRef(ref), queue: Promise.resolve() };
    this.refOwners.add(owner);
    return owner;
  },

  checkpointOwnedBranch(owner) {
    if (!owner) return Promise.resolve();
    if (owner.closePromise) return owner.closePromise;
    const checkpoint = owner.queue.then(async () => {
      // Wait for any daemon receipts on this exact branch before observing the owner window.
      await Promise.allSettled([...(this.refWrites.get(owner.ref) ?? [])]);
      const live = this.store.task(owner.taskId);
      if (live.branch !== owner.branch || live.workspace !== owner.workspace) return;
      if (await this.git(owner.workspace, 'symbolic-ref', '--quiet', 'HEAD').catch(() => null) !== owner.ref) return;
      const after = await this.readGuardRef(owner.ref);
      if (!owner.head || !after || after === owner.head) return after;
      const before = owner.head;
      owner.head = after;
      const source = { kind: 'owner', worker_id: owner.taskId, run_id: owner.runId };
      this.noteRefTransition(owner.ref, before, after, source);
      this.store.event(owner.taskId, 'invocation.branch_observed', {
        branch: owner.branch, before, after, run_id: owner.runId,
        source: 'worker_ownership_window',
      });
      return after;
    });
    owner.queue = checkpoint.catch(() => {});
    return checkpoint;
  },

  async closeOwnedBranch(owner) {
    if (!owner) return;
    if (!owner.closePromise) owner.closePromise = (async () => {
      try { return await this.checkpointOwnedBranch(owner); }
      finally { this.refOwners.delete(owner); }
    })();
    return owner.closePromise;
  },

  async checkWatchedBranch(watch) {
    // A parent may still be running OR have already returned. Its checkpoints survive in
    // this watch until the child exits; a bare running Map entry cannot authorize anything.
    let after, explained;
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const owner of [...this.refOwners]) if (owner.ref === watch.ref) await this.checkpointOwnedBranch(owner);
      await Promise.allSettled([...(this.refWrites.get(watch.ref) ?? [])]);
      after = await this.readGuardRef(watch.ref);
      const reachable = new Set([watch.baseline]), tips = [watch.baseline], edges = new Map();
      // Receipts can finish out of order. Only a connected chain of exact tips explains drift;
      // an earlier legitimate write does not excuse a later unobserved move on the same ref.
      for (const transition of watch.transitions) {
        const next = edges.get(transition.before) ?? new Set();
        next.add(transition.after); edges.set(transition.before, next);
      }
      for (let i = 0; i < tips.length; i++) for (const next of edges.get(tips[i]) ?? []) if (!reachable.has(next)) {
        reachable.add(next); tips.push(next);
      }
      explained = after === watch.baseline || (!watch.overflow && reachable.has(after));
      if (explained || watch.overflow) break;
      // A write can finish between the checkpoint and ref read. Retry observations,
      // never grant blanket permission just because some owner/write is active.
    }
    return { before: watch.baseline, after, explained,
      overflow: watch.overflow, transitions: watch.transitions };
  },
};
