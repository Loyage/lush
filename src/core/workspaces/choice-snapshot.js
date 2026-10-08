import fs from 'node:fs';
import path from 'node:path';
import { check } from '../types.js';
import { isolatedGit, runGit, readWorkspace, hash, internal, relativePath, compare } from './code-io.js';

const MAX_FILES = 10000, MAX_BYTES = 64 * 1024 * 1024;
const oid = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
function snapshotRef(noticeId) {
  check(Number.isSafeInteger(noticeId) && noticeId > 0, 'invalid choice snapshot notice id');
  return `refs/lush/choice-snapshots/${noticeId}`;
}
// Named credential files are never copied. Arbitrary secrets embedded in source cannot be inferred.
function excluded(name) {
  return internal(name) || name.split('/').some(part => /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.git-credentials|auth\.json|credentials(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx))$/i.test(part));
}
function names(buffer) {
  const text = buffer.toString('utf8');
  check(Buffer.from(text).equals(buffer), 'choice snapshot requires UTF-8 file names');
  return text.split('\0').filter(Boolean);
}
function assertOwner(workspaces, task) {
  const live = workspaces.store.task(task.id);
  check(live.workspace === task.workspace && live.branch === task.branch && task.branch,
    'choice snapshot Worker identity changed');
  const root = path.resolve(workspaces.config.home, 'worktrees');
  check(task.workspace && path.dirname(path.resolve(task.workspace)) === root
    && fs.realpathSync(task.workspace) === path.resolve(task.workspace)
    && fs.realpathSync(root) === root && fs.realpathSync(workspaces.config.home) === path.resolve(workspaces.config.home)
    && path.resolve(task.workspace) !== fs.realpathSync(workspaces.config.project),
  'choice snapshot requires a private Worker worktree');
  const branch = workspaces.store.branch(task.branch);
  check(branch?.task_id === task.id && branch.worktree === task.workspace && branch.status === 'active',
    'choice snapshot branch ownership changed');
}

async function manifest(workspaces, context) {
  const head = names(await context.git(['ls-tree', '-rz', '--full-tree', context.head]));
  const stagedRaw = await runGit(workspaces.config, context.workspace, ['ls-files', '--stage', '-z'], { deadline: context.deadline });
  const staged = names(stagedRaw), paths = new Set();
  for (const [entry, indexEntry] of [...head.map(entry => [entry, false]), ...staged.map(entry => [entry, true])]) {
    const tab = entry.indexOf('\t');
    check(tab > 0, 'invalid choice snapshot Git entry');
    const meta = entry.slice(0, tab).split(' '), name = entry.slice(tab + 1);
    check(meta[0] !== '160000', 'choice snapshots do not support submodules');
    if (indexEntry) check(meta[2] === '0', 'choice snapshots require a conflict-free index');
    // Omitting any tracked path would turn a partial tree into a false complete checkpoint.
    // Reject even deleted worktree files and index-only additions; never inspect their bytes.
    check(!excluded(name), 'choice snapshot contains tracked internal or credential files');
    relativePath(name); paths.add(name);
  }
  // Use the real read-only repository for ignore rules (including info/exclude), not its filters.
  for (const name of names(await runGit(workspaces.config, context.workspace,
    ['ls-files', '--others', '--exclude-standard', '-z'], { deadline: context.deadline }))) {
    if (!excluded(name)) { relativePath(name); paths.add(name); }
  }
  check(paths.size <= MAX_FILES, 'choice snapshot exceeds 10000 files');
  return { paths: [...paths].sort(compare), index: hash(stagedRaw) };
}
function sample(workspace, paths) {
  let bytes = 0;
  return paths.map(name => {
    const file = readWorkspace(workspace, name);
    check(!file.exists || file.kind === 'file', 'choice snapshots do not support links, directories or special files');
    check(file.buffer !== null, 'choice snapshot file exceeds 8 MiB');
    bytes += file.size;
    check(bytes <= MAX_BYTES, 'choice snapshot exceeds 64 MiB');
    return { name, ...file, digest: hash(file.buffer) };
  });
}
const sampleIdentity = files => JSON.stringify(files.map(file => [file.name, file.exists, file.mode, file.signature, file.digest]));

export const methods = {
  captureChoiceSnapshot(task, noticeId, guard = undefined) {
    const ref = snapshotRef(noticeId);
    return this.exclusive(async () => {
      await guard?.();
      assertOwner(this, task);
      const context = await isolatedGit(this, task, 'working');
      try {
        check(context.source === 'workspace', 'choice snapshot worktree is unavailable');
        // A ref is immutable per notice; unknown earlier side effects are not overwritten.
        const probe = await runGit(this.config, this.config.project, ['rev-parse', '--verify', '--quiet', ref], { codes: [0, 1] });
        check(probe.length === 0, 'choice snapshot ref already exists');
        const before = await manifest(this, context), files = sample(context.workspace, before.paths);
        const objects = (await context.git(['rev-parse', '--git-path', 'objects'])).toString().trim();
        const env = { GIT_DIR: path.join(context.root, 'git'), GIT_OBJECT_DIRECTORY: objects,
          GIT_WORK_TREE: context.workspace, GIT_INDEX_FILE: path.join(context.root, 'index'),
          GIT_AUTHOR_NAME: 'Lush', GIT_AUTHOR_EMAIL: 'snapshot@lush.invalid',
          GIT_COMMITTER_NAME: 'Lush', GIT_COMMITTER_EMAIL: 'snapshot@lush.invalid' };
        const git = args => context.git(args, { env });
        await git(['read-tree', '--empty']);
        const present = files.filter(file => file.exists);
        for (let start = 0; start < present.length; start += 100) {
          const batch = present.slice(start, start + 100);
          const blobs = batch.map((file, i) => {
            const filename = path.join(context.root, `blob-${start + i}`);
            fs.writeFileSync(filename, file.buffer, { flag: 'wx', mode: 0o600 }); return filename;
          });
          const hashes = (await git(['hash-object', '-w', '--no-filters', ...blobs])).toString().trim().split('\n');
          check(hashes.length === batch.length && hashes.every(oid), 'invalid choice snapshot object result');
          const args = ['update-index', '--add'];
          for (let i = 0; i < batch.length; i++) args.push('--cacheinfo', `${batch[i].mode},${hashes[i]},${batch[i].name}`);
          await git(args);
          for (const filename of blobs) fs.unlinkSync(filename);
        }
        const tree = (await git(['write-tree'])).toString().trim();
        check(oid(tree), 'invalid choice snapshot tree');
        const commit = (await git(['commit-tree', tree, '-p', context.head, '-m', `Lush choice snapshot notice ${noticeId}`])).toString().trim();
        check(oid(commit), 'invalid choice snapshot commit');
        await guard?.();
        assertOwner(this, task);
        const after = await manifest(this, context);
        await context.verify();
        check(JSON.stringify(before) === JSON.stringify(after)
          && sampleIdentity(files) === sampleIdentity(sample(context.workspace, after.paths)),
        'worktree changed while capturing choice snapshot');
        // No await between final admission/ownership checks and spawning update-ref: cancellation
        // during the preceding asynchronous Git validation must not publish a stale checkpoint.
        const admission = guard?.();
        if (admission && typeof admission.then === 'function') {
          Promise.resolve(admission).catch(() => {});
          throw new Error('choice snapshot publication guard must be synchronous');
        }
        assertOwner(this, task);
        // CAS protects a competing ref publisher; only this Notice's private ref is written.
        await runGit(this.config, this.config.project, ['update-ref', ref, commit, '0'.repeat(commit.length)]);
        return { commit, ref, source_head: context.head };
      } finally { context.close(); }
    });
  },

  removeChoiceSnapshot(noticeId, commit) {
    const ref = snapshotRef(noticeId);
    check(oid(commit), 'invalid choice snapshot commit');
    return this.exclusive(async () => {
      await runGit(this.config, this.config.project, ['update-ref', '-d', ref, commit]);
      return { ref, commit };
    });
  },
};
