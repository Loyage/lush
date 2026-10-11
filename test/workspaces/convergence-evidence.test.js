import { test, expect } from 'bun:test';
import { setup, git } from './convergence-harness.js';

async function evidenceFor(f, root, members = f.members, run_id = 1, generation = 1) {
  const commit = await git(f.root, 'commit-tree', root.tree, '-p', root.commit,
    ...members.flatMap(member => ['-p', member.source_commit]), '-m', 'fixed convergence provenance');
  const evidence = { ref: `refs/lush/convergence-evidence/${run_id}/${generation}`, commit };
  // Registration belongs to the parent preparation coordinator, not the Git boundary.
  f.store.run('INSERT INTO meta(key,value) VALUES (?,?)', `convergence_evidence:${run_id}:${generation}`, JSON.stringify(evidence));
  return evidence;
}

async function ready() {
  const f = await setup();
  try {
    await f.member('a', { 'a.txt': 'a\n' }); await f.member('b', { 'b.txt': 'b\n' });
    const root = await f.combine(), evidence = await evidenceFor(f, root);
    const receipt = await f.prepare(root.tree, { evidence });
    return { ...f, rootNode: root, evidence, receipt };
  } catch (error) { f.close(); throw error; }
}

async function prune(f) {
  await f.workspaces.exclusive(async () => {
    await git(f.root, '-c', 'core.hooksPath=/dev/null', 'reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all');
    await git(f.root, '-c', 'core.hooksPath=/dev/null', 'gc', '--prune=now');
  });
}

async function untouched(f) {
  expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(f.baseline);
  expect(await git(f.root, 'status', '--porcelain')).toBe('');
  for (const member of f.members) expect(await git(member.workspace, 'rev-parse', 'HEAD')).toBe(member.source_commit);
}

test('optional keeper receipt survives JSON, pure prepare does not create ref, and publish creates keeper atomically with one target commit', async () => {
  const f = await ready();
  try {
    expect(f.receipt.evidence).toEqual(f.evidence); expect(Object.isFrozen(f.receipt.evidence)).toBe(true);
    await expect(git(f.root, 'show-ref', '--verify', f.evidence.ref)).rejects.toThrow(); await untouched(f);
    const serialized = JSON.parse(JSON.stringify(f.receipt));
    const original = f.workspaces.git; let checked = false;
    f.workspaces.git = async function(cwd, ...args) {
      if (args[0] === 'read-tree') {
        checked = true;
        await expect(git(f.root, 'update-ref', f.evidence.ref, f.baseline)).rejects.toThrow('lock');
        await expect(git(f.root, 'show-ref', '--verify', f.evidence.ref)).rejects.toThrow();
      }
      return original.call(this, cwd, ...args);
    };
    await f.apply(serialized); expect(checked).toBe(true);
    expect(await git(f.root, 'rev-parse', f.evidence.ref)).toBe(f.evidence.commit);
    expect(await git(f.root, 'show', '-s', '--format=%P', 'HEAD')).toBe(f.baseline);
    expect(await git(f.root, 'rev-list', '--count', `${f.baseline}..HEAD`)).toBe('1');
    expect(await f.workspaces.verifyConvergencePublishUnsafe(serialized)).toBe(true);
    for (const member of f.members) expect(await git(member.workspace, 'rev-parse', 'HEAD')).toBe(member.source_commit);
  } finally { f.close(); }
});

test('pre-pinned exact keeper is verified and locked, never recreated or overwritten', async () => {
  const f = await ready();
  try {
    await f.workspaces.exclusive(() => git(f.root, 'update-ref', f.evidence.ref, f.evidence.commit, '0'.repeat(f.evidence.commit.length)));
    const original = f.workspaces.git;
    f.workspaces.git = async function(cwd, ...args) {
      if (args[0] === 'read-tree') await expect(git(f.root, 'update-ref', f.evidence.ref, f.baseline, f.evidence.commit)).rejects.toThrow('lock');
      return original.call(this, cwd, ...args);
    };
    await f.apply(f.receipt);
    expect(await git(f.root, 'rev-parse', f.evidence.ref)).toBe(f.evidence.commit);
    expect(await f.workspaces.verifyConvergencePublishUnsafe(f.receipt)).toBe(true);
  } finally { f.close(); }
});

for (const before of [true, false]) test(`cancellation ${before ? 'before' : 'after'} checkout aborts new keeper with target CAS and preserves partial evidence`, async () => {
  const f = await ready();
  try {
    const original = f.workspaces.git; let cancelled = before;
    f.workspaces.git = async function(cwd, ...args) {
      const result = await original.call(this, cwd, ...args);
      if (args[0] === 'read-tree') cancelled = true;
      return result;
    };
    await expect(f.apply(f.receipt, () => !cancelled)).rejects.toThrow('cancelled');
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(f.baseline);
    await expect(git(f.root, 'show-ref', '--verify', f.evidence.ref)).rejects.toThrow();
    expect(await f.workspaces.verifyConvergencePublishUnsafe(f.receipt)).toBe(false);
    if (before) expect(await git(f.root, 'status', '--porcelain')).toBe('');
    else expect(await git(f.root, 'write-tree')).toBe(f.receipt.tree);
  } finally { f.close(); }
});

test('keeper drift cannot be overwritten, even an equivalent-tree replacement invalidates exact recovery and member proof', async () => {
  const f = await ready();
  try {
    await git(f.root, 'update-ref', f.evidence.ref, f.baseline);
    await expect(f.apply(f.receipt)).rejects.toThrow('evidence ref moved'); await untouched(f);
    expect(await git(f.root, 'rev-parse', f.evidence.ref)).toBe(f.baseline);
    await git(f.root, 'update-ref', f.evidence.ref, f.evidence.commit, f.baseline);
    await f.apply(f.receipt); f.settle(f.receipt);
    const replacement = await git(f.root, 'commit-tree', f.receipt.tree, '-p', f.evidence.commit, '-m', 'equivalent but different');
    await git(f.root, 'update-ref', f.evidence.ref, replacement, f.evidence.commit);
    expect(await f.workspaces.verifyConvergencePublishUnsafe(f.receipt)).toBe(false);
    const a = f.members[0];
    expect(await f.workspaces.squashedLanded(a.source_branch, f.receipt.commit)).toBe(false);
    await expect(f.workspaces.taskSyncBase(f.store.task(a.task_id), a.source_commit, f.receipt.commit)).rejects.toThrow('evidence ref moved');
    await expect(f.workspaces.exclusive(() => f.workspaces.archiveSquashedTaskUnsafe(f.store.task(a.task_id), a.source_commit, f.receipt.commit))).rejects.toThrow('evidence ref moved');
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(f.receipt.commit);
  } finally { f.close(); }
});

test('evidence ref identity must be normative for its exact run/generation and preserve every source and final tree', async () => {
  const f = await ready();
  try {
    for (const ref of ['refs/heads/main', 'refs/lush/convergence-evidence/1/2', 'refs/lush/convergence-evidence/2/1',
      'refs/lush/convergence-evidence/01/1', 'refs/lush/convergence-evidence/1/1\nverify refs/heads/main']) {
      await expect(f.prepare(f.receipt.tree, { evidence: { ...f.evidence, ref } })).rejects.toThrow('evidence identity');
    }
    await expect(f.prepare(f.receipt.tree, { evidence: { ...f.evidence, commit: f.members[0].source_commit } })).rejects.toThrow('final tree');
    // Normalized leaves have only the baseline as parent, so the root alone is insufficient provenance.
    await expect(f.prepare(f.receipt.tree, { evidence: { ...f.evidence, commit: f.rootNode.commit } })).rejects.toThrow('every fixed source');
    const unrelated = await git(f.root, 'commit-tree', f.receipt.tree, '-m', 'unrelated root');
    await expect(f.prepare(f.receipt.tree, { evidence: { ...f.evidence, commit: unrelated } })).rejects.toThrow('baseline');
    await untouched(f);
  } finally { f.close(); }
});

test('symbolic keeper refs, including dangling refs racing with create, cannot redirect private publication to another branch', async () => {
  for (const race of [false, true]) {
    const f = await ready();
    try {
      const unrelated = 'refs/heads/never-write-here';
      if (!race) await git(f.root, 'symbolic-ref', f.evidence.ref, unrelated);
      else {
        const original = f.workspaces.git; let injected = false;
        f.workspaces.git = async function(cwd, ...args) {
          try { return await original.call(this, cwd, ...args); }
          catch (error) {
            if (!injected && args[0] === 'rev-parse' && args.includes(f.evidence.ref)) {
              injected = true; await git(f.root, 'symbolic-ref', f.evidence.ref, unrelated);
            }
            throw error;
          }
        };
      }
      await expect(f.apply(f.receipt)).rejects.toThrow(race ? 'moved or locked' : 'must not be symbolic');
      expect(await git(f.root, 'symbolic-ref', f.evidence.ref)).toBe(unrelated);
      await expect(git(f.root, 'show-ref', '--verify', unrelated)).rejects.toThrow();
      await untouched(f);
    } finally { f.close(); }
  }
});

test('deleted keeper cannot be guessed or recreated by read-only recovery, even while its commit objects still exist', async () => {
  const f = await ready();
  try {
    await f.apply(f.receipt); f.settle(f.receipt);
    await git(f.root, 'update-ref', '-d', f.evidence.ref, f.evidence.commit);
    expect(await f.workspaces.verifyConvergencePublishUnsafe(f.receipt)).toBe(false);
    const a = f.members[0];
    await expect(f.workspaces.taskSyncBase(f.store.task(a.task_id), a.source_commit, f.receipt.commit)).rejects.toThrow('ref is missing');
    await expect(git(f.root, 'show-ref', '--verify', f.evidence.ref)).rejects.toThrow();
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(f.receipt.commit);
  } finally { f.close(); }
});

test('real GC after peer archival retains cross-member provenance, remaining sync and second iteration through the keeper', async () => {
  const f = await ready();
  try {
    await f.apply(f.receipt); f.settle(f.receipt);
    const [a, b] = f.members, firstSource = a.source_commit;
    await f.workspaces.exclusive(() => f.workspaces.archiveSquashedTaskUnsafe(f.store.task(b.task_id), b.source_commit, f.receipt.commit));
    await prune(f);
    await git(f.root, 'cat-file', '-e', `${b.source_commit}^{commit}`);
    await git(f.root, 'cat-file', '-e', `${f.rootNode.commit}^{commit}`);
    expect(await git(f.root, 'rev-parse', f.evidence.ref)).toBe(f.evidence.commit);
    expect(await f.workspaces.squashedLanded(a.source_branch, f.receipt.commit)).toBe(true);
    expect(await f.workspaces.taskSyncBase(f.store.task(a.task_id), a.source_commit, f.receipt.commit)).toBe(firstSource);
    await f.change(a, { 'a.txt': 'second\n' });
    const normalized = await f.workspaces.mergeConvergenceObjects({ base: firstSource, left: f.receipt.commit,
      right: a.source_commit, parents: [f.receipt.commit], message: 'second increment' });
    expect(normalized.conflict).toBe(false); expect(await git(f.root, 'show', `${normalized.commit}:b.txt`)).toBe('b');
    const synced = await f.workspaces.exclusive(() => f.workspaces.syncTaskParentUnsafe(f.store.task(a.task_id), a.source_commit, f.receipt.commit));
    expect(synced.conflict).toBe(false); a.source_commit = synced.head_commit;
    const secondEvidence = await evidenceFor(f, normalized, [a], 2);
    const second = await f.prepare(normalized.tree, { members: [a], base: f.receipt.commit, run_id: 2, evidence: secondEvidence });
    await f.apply(second); f.settle(second); await prune(f);
    expect(await f.workspaces.squashedLanded(a.source_branch, second.commit)).toBe(true);
    expect(await git(f.root, 'show', 'HEAD:a.txt')).toBe('second'); expect(await git(f.root, 'show', 'HEAD:b.txt')).toBe('b');
    await git(f.root, 'cat-file', '-e', `${b.source_commit}^{commit}`);
    expect(await git(f.root, 'rev-parse', f.evidence.ref)).toBe(f.evidence.commit);
    expect(await git(f.root, 'rev-parse', secondEvidence.ref)).toBe(secondEvidence.commit);
  } finally { f.close(); }
});

test('GC control confirms an archived peer original commit is unreachable without a keeper; old optional-less receipt remains compatible', async () => {
  const f = await setup();
  try {
    await f.member('a', { 'a.txt': 'a\n' }); const b = await f.member('b', { 'b.txt': 'b\n' });
    const root = await f.combine(), receipt = await f.prepare(root.tree);
    expect(Object.hasOwn(receipt, 'evidence')).toBe(false);
    await f.apply(receipt); f.settle(receipt);
    await f.workspaces.exclusive(() => f.workspaces.archiveSquashedTaskUnsafe(f.store.task(b.task_id), b.source_commit, receipt.commit));
    await prune(f);
    await expect(git(f.root, 'cat-file', '-e', `${b.source_commit}^{commit}`)).rejects.toThrow();
    expect(await git(f.root, 'show', 'HEAD:b.txt')).toBe('b');
  } finally { f.close(); }
});
