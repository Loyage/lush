import { check } from '../types.js';
import { randomUUID } from 'node:crypto';
import { taskLabel } from '../naming.js';
import { hash, stable } from '../../runner/protocol.js';
import { identityKeys, baseIdentity, oid, phaseId, guarded, call, assertions, bundle, upload, download, quarantine } from './remote-transfer.js';

function request(options) {
  check(typeof options.request_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(options.request_id), 'remote operation requires a durable request_id');
}
function receiptIdentity(options) { return { ...baseIdentity(options.identity), ...(options.identity.run_id
  ? { run_id: options.identity.run_id } : { operation_id: options.identity.operation_id }), request_id: options.request_id }; }
function update(owner, options, state, evidence) {
  const receipt = owner.store.runnerReceipt(options.request_id);
  return owner.store.updateRunnerReceipt(receiptIdentity(options), { state, ...(evidence ? { evidence } : {}) }, receipt.revision);
}
async function registration(owner, options) {
  const binding = guarded(owner, options), task = owner.store.task(options.identity.worker_id), row = owner.store.branch(task.branch);
  check(row?.status === 'active' && row.task_id === task.id && row.worktree === null && row.parent === task.target_branch
    && task.workspace === null && task.base_commit === binding.base_commit, 'remote branch registration changed');
  let symbolic = null;
  try { symbolic = await owner.git(owner.config.project, 'symbolic-ref', '--quiet', `refs/heads/${task.branch}`); } catch { /* ordinary direct ref */ }
  check(!symbolic, 'remote authoritative ref must not be symbolic');
  check(!(await owner.checkedOut(task.branch)), 'remote authoritative branch must not have a local editable worktree');
  guarded(owner, options);
  return { binding, task, ref: `refs/heads/${task.branch}` };
}
async function current(owner, options, expected) {
  const state = await registration(owner, options);
  check(await owner.git(owner.config.project, 'rev-parse', '--verify', state.ref) === expected, 'remote authoritative ref drifted');
  guarded(owner, options); return state;
}
async function barrier(owner, options) {
  guarded(owner, options);
  const result = await options.client.call('workspace.barrier');
  guarded(owner, options);
  check(result.stopped === true && result.total === 0 && !result.busy && !result.truncated, 'remote workspace has active or unknown writers');
}

/** Internal only: caller owns lifecycle admission and provides an already handshaken control client. */
export const methods = {
  /** Inside exclusive; persist ownership before creating only the central authoritative ref. */
  async prepareRemoteBranchUnsafe(task, parentBranch, commit, options) {
    oid(commit);
    check(typeof options.guard === 'function' && !options.guard()?.then, 'remote creation requires synchronous guard');
    check(task.id === options.identity.worker_id && !task.workspace && ['order', 'child'].includes(task.task_kind), 'remote creation requires a new dedicated Worker');
    check(await this.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${parentBranch}^{commit}`) === commit, 'remote parent baseline changed');
    const branch = `lush/${this.namespace}/${taskLabel(task.id, task.name)}`;
    const old = this.store.branch(branch);
    check(!old || old.task_id === task.id && old.created_from_commit === commit && old.parent === parentBranch && old.worktree === null, 'remote branch ownership changed');
    options.guard();
    this.store.bindRunnerWorkspace({ ...baseIdentity(options.identity), base_commit: commit });
    this.store.update(task.id, { branch, workspace: null, base_commit: commit, target_branch: parentBranch });
    if (!old) this.store.recordBranch({ branch, parent: parentBranch, created_from_commit: commit, task_id: task.id, worktree: null });
    let tip = null;
    try { tip = await this.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${branch}`); } catch { /* new ref */ }
    check(tip === null || tip === commit, 'remote branch already moved');
    let symbolic = null;
    try { symbolic = await this.git(this.config.project, 'symbolic-ref', '--quiet', `refs/heads/${branch}`); } catch { /* direct or absent */ }
    check(!symbolic, 'remote authoritative ref must not be symbolic');
    guarded(this, options);
    if (tip === null) await this.git(this.config.project, 'update-ref', '--no-deref', `refs/heads/${branch}`, commit, '0'.repeat(commit.length));
    return { branch, commit, identity: baseIdentity(options.identity) };
  },

  async prepareRemoteWorkspace(options) {
    request(options);
    const { binding, task } = await this.exclusive(() => current(this, options, guarded(this, options).base_commit));
    check(['preparing', 'ready'].includes(binding.state), 'remote preparation is unknown');
    await options.client.call('workspace.register', {}, { request_id: phaseId(options.request_id, 'register') });
    guarded(this, options);
    const result = await bundle(this, binding.base_commit, async object => {
      const artifact = await upload(this, options, object, phaseId(options.request_id, 'seed'));
      return call(this, options, 'workspace.git.apply', { empty: true, steps: [
        { argv: ['init', `--initial-branch=${task.branch}`, `--object-format=${binding.base_commit.length === 64 ? 'sha256' : 'sha1'}`] },
        { argv: ['bundle', 'verify', artifact] },
        { argv: ['fetch', '--no-tags', '--no-write-fetch-head', artifact, binding.base_commit] },
        { argv: ['checkout', '-b', task.branch, binding.base_commit] },
        ...assertions(task.branch, binding.base_commit, true),
      ] }, 'prepare');
    });
    await this.exclusive(async () => {
      const state = await current(this, options, binding.base_commit);
      if (state.binding.state !== 'ready') this.store.confirmRunnerWorkspace(baseIdentity(options.identity), binding.base_commit, state.binding.revision);
    });
    return { head_commit: binding.base_commit, branch: task.branch, result };
  },

  async inspectRemoteWorkspace(options) {
    request(options);
    const { task } = await this.exclusive(() => registration(this, options));
    await barrier(this, options);
    const result = await options.client.call('workspace.git.inspect', { require_no_lease: options.final_delivery === true || options.require_no_lease === true, steps: [
      { argv: ['symbolic-ref', '--short', 'HEAD'], expect: task.branch },
      { argv: ['rev-parse', '--verify', 'HEAD'] },
      { argv: ['status', '--porcelain=v1', '--untracked-files=all'] },
    ] }, { request_id: randomUUID() });
    guarded(this, options);
    const head_commit = result.results[1]; oid(head_commit);
    return { identity: baseIdentity(options.identity), branch: task.branch, head_commit, clean: result.results[2] === '',
      revision: hash(stable([baseIdentity(options.identity), ...result.results])) };
  },

  /** Read seam only; Project code-reader routing and pagination projections are not installed here. */
  async readRemoteFile(options, { path, expected_head, expected_sha256, offset = 0, limit = 16000 }) {
    oid(expected_head);
    check(typeof expected_sha256 === 'string' && /^[a-f0-9]{64}$/.test(expected_sha256), 'remote file read requires fixed content revision');
    const before = await this.inspectRemoteWorkspace({ ...options, request_id: randomUUID() });
    check(before.head_commit === expected_head, 'remote read HEAD is stale');
    const result = await options.client.call('file.read', { path, expected_sha256, offset, limit });
    guarded(this, options);
    const after = await this.inspectRemoteWorkspace({ ...options, request_id: randomUUID() });
    check(after.head_commit === expected_head && after.revision === before.revision && result.sha256 === expected_sha256, 'remote file revision changed');
    return { ...result, head_commit: expected_head, source: 'runner', revision: hash(stable([after.revision, result.sha256])) };
  },

  /** During an active Run (for spawn), or at a separately guarded final delivery safe point. */
  async receiveRemoteCommit(options) {
    request(options); oid(options.commit); oid(options.old_commit); oid(options.original_commit);
    if (options.final_delivery) check(options.agent_exited === true, 'final remote delivery requires Agent exit');
    const previous = this.store.runnerReceipt(options.request_id);
    if (previous?.state === 'accepted') {
      const expectedHash = hash(stable({ commit: options.commit, old_commit: options.old_commit, original_commit: options.original_commit,
        artifact: { artifact_id: phaseId(options.request_id, 'result-bundle'), sha256: previous.data.digest, size: previous.data.size_bytes } }));
      check(previous.params_hash === expectedHash && identityKeys.every(key => previous[key] === options.identity[key])
        && (previous.run_id ?? null) === (options.identity.run_id ?? null) && (previous.operation_id ?? null) === (options.identity.operation_id ?? null),
      'remote receive request changed');
      if (options.final_delivery) {
        await barrier(this, options);
        const observed = await this.inspectRemoteWorkspace({ ...options, request_id: randomUUID() });
        check(observed.clean && observed.head_commit === options.commit, 'remote final delivery changed after receipt');
      }
      await this.exclusive(() => current(this, options, options.commit));
      check(previous.data.commit === options.commit && previous.data.old_commit === options.old_commit, 'remote receive request changed');
      return previous;
    }
    const { task } = await this.exclusive(async () => {
      const state = await registration(this, options);
      const tip = await this.git(this.config.project, 'rev-parse', '--verify', state.ref);
      check(tip === options.old_commit || previous?.state === 'received' && tip === options.commit
        && previous.data.commit === options.commit && previous.data.old_commit === options.old_commit, 'remote authoritative ref drifted');
      return state;
    });
    if (options.final_delivery) { check(options.agent_exited === true, 'final remote delivery requires Agent exit'); await barrier(this, options); }
    const lease = options.identity.run_id !== undefined ? { capture_run_id: options.identity.run_id } : { require_no_lease: true };
    const exported = await call(this, options, 'workspace.git.export', {
      ...lease, output_artifact: phaseId(options.request_id, 'result-bundle'), steps: [
        ...assertions(task.branch, options.commit, Boolean(options.final_delivery)),
        { argv: ['merge-base', '--is-ancestor', options.original_commit, options.commit], expect: '' },
        { argv: ['bundle', 'create', { artifact_id: phaseId(options.request_id, 'result-bundle') }, `refs/heads/${task.branch}`] },
        ...assertions(task.branch, options.commit, Boolean(options.final_delivery)),
      ],
    }, 'export');
    guarded(this, options);
    let receipt = this.store.createRunnerReceipt({ ...receiptIdentity(options), authorization_version: options.authorization_version,
      kind: 'objects', params_hash: hash(stable({ commit: options.commit, old_commit: options.old_commit, original_commit: options.original_commit,
        artifact: exported.artifact })),
      data: { old_commit: options.old_commit, commit: options.commit, digest: exported.artifact.sha256, size_bytes: exported.artifact.size } });
    const bytes = await download(this, options, exported.artifact);
    const evidence = { head_commit: options.commit, digest: exported.artifact.sha256, size_bytes: bytes.length, verified: true };
    if (receipt.state === 'prepared') receipt = update(this, options, 'received', evidence);
    return quarantine(this, bytes, options.commit, options.original_commit, async repository => {
      await options.client.call('workspace.git.inspect', { ...lease, steps: assertions(task.branch, options.commit, Boolean(options.final_delivery)) }, { request_id: randomUUID() });
      guarded(this, options);
      if (options.final_delivery) {
        await barrier(this, options);
        const final = await this.inspectRemoteWorkspace({ ...options, request_id: randomUUID() });
        check(final.head_commit === options.commit && final.clean, 'remote final delivery changed during transfer');
      }
      return this.exclusive(async () => {
        const tip = await this.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${task.branch}`);
        check(tip === options.old_commit || previous?.state === 'received' && tip === options.commit, 'remote authoritative ref drifted');
        await current(this, options, tip);
        check(await this.isAncestor(repository, options.old_commit, options.commit), 'remote commit rewrote its accepted tip');
        const candidate = `refs/lush/remote-candidates/${phaseId(options.request_id, options.commit)}`;
        await this.git(this.config.project, '-c', 'fetch.fsckObjects=true', 'fetch', '--no-tags', '--no-write-fetch-head', repository, `${options.commit}:${candidate}`);
        await current(this, options, tip);
        guarded(this, options);
        // No network or SQLite transaction spans this short compare-and-swap interval.
        if (tip !== options.commit) await this.git(this.config.project, 'update-ref', '--no-deref', `refs/heads/${task.branch}`, options.commit, options.old_commit);
        const accepted = update(this, options, 'accepted', evidence);
        await this.git(this.config.project, 'update-ref', '-d', candidate, options.commit);
        return accepted;
      });
    });
  },

  /** Fixed parent objects for source-side repair. Never checks out or advances the source HEAD. */
  async provideRemoteCommit(options) {
    request(options); oid(options.commit); oid(options.head_commit);
    const { task } = await this.exclusive(() => current(this, options, options.head_commit));
    await barrier(this, options);
    await bundle(this, options.commit, async object => {
      const artifact = await upload(this, options, object, phaseId(options.request_id, 'repair-bundle'));
      await call(this, options, 'workspace.git.apply', { steps: [
        ...assertions(task.branch, options.head_commit, true),
        { argv: ['bundle', 'verify', artifact] },
        { argv: ['fetch', '--no-tags', '--no-write-fetch-head', artifact, options.commit] },
        ...assertions(task.branch, options.head_commit, true),
      ] }, 'repair-objects');
    });
    await this.exclusive(() => current(this, options, options.head_commit));
    return { head_commit: options.head_commit, provided_commit: options.commit };
  },

  /** Caller persists prepared before central Squash, landed only after exact Git landing proof. No Squash here. */
  async syncRemoteWorkspace(options) {
    request(options);
    let receipt = this.store.runnerReceipt(options.request_id);
    check(receipt?.kind === 'parent_sync' && identityKeys.every(key => receipt[key] === options.identity[key])
      && receipt.operation_id === options.identity.operation_id, 'remote parent sync requires its fixed persistent receipt');
    const { old_commit, new_commit } = receipt.data;
    const { task } = await this.exclusive(() => current(this, options, new_commit));
    if (receipt.state === 'acknowledged') return receipt;
    check(['landed', 'applying'].includes(receipt.state), 'remote sync has no central landing proof');
    await barrier(this, options);
    const observed = await this.inspectRemoteWorkspace({ ...options, require_no_lease: true, request_id: phaseId(options.request_id, 'sync-observe') });
    check(observed.clean && [old_commit, new_commit].includes(observed.head_commit), 'remote sync found dirty or unknown HEAD; preserve workspace');
    if (observed.head_commit === old_commit) {
      if (receipt.state === 'landed') receipt = update(this, options, 'applying');
      await bundle(this, new_commit, async object => {
        const artifact = await upload(this, options, object, phaseId(options.request_id, 'sync-bundle'));
        await call(this, options, 'workspace.git.apply', { steps: [
          ...assertions(task.branch, old_commit, true),
          { argv: ['bundle', 'verify', artifact] },
          { argv: ['fetch', '--no-tags', '--no-write-fetch-head', artifact, new_commit] },
          ...assertions(task.branch, old_commit, true),
          { argv: ['merge', '--ff-only', new_commit] },
          ...assertions(task.branch, new_commit, true),
        ] }, 'sync-apply');
      });
    }
    await barrier(this, options);
    // This fresh sample must not be a cached pre-apply observation.
    await options.client.call('workspace.git.inspect', { require_no_lease: true, steps: assertions(task.branch, new_commit, true) }, { request_id: randomUUID() });
    guarded(this, options);
    return this.exclusive(async () => {
      await current(this, options, new_commit);
      return update(this, options, 'acknowledged', { head_commit: new_commit, clean: true, stopped: true });
    });
  },

  /** Deletion-only preparation recovery; ordinary NOT_FOUND is not absence evidence. */
  async inspectUnpreparedRemoteWorkspace(options) {
    request(options);
    const { binding } = await this.exclusive(() => current(this, options, guarded(this, options).base_commit));
    const receipt = this.store.runnerReceipt(options.request_id);
    this.store.assertRunnerUnprepared(binding.worker_id, receipt ? options.request_id : null);
    check(['workspace.preparation.inspect', 'workspace.preparation.close'].every(method => options.client.capabilities?.includes(method)),
      'Runner does not support verified preparation closure');
    const evidence = await options.client.call('workspace.preparation.inspect');
    guarded(this, options);
    check(evidence?.absent === true && Object.keys(evidence).every(key =>
      ['identity', 'absent', 'closed', 'request_id', 'operation_id', 'request_fingerprint'].includes(key))
      && evidence.identity && identityKeys.every(key => evidence.identity[key] === options.identity[key])
      && Object.keys(evidence.identity).length === identityKeys.length, 'Runner preparation absence proof is incomplete or changed');
    if (evidence.closed !== undefined) check(evidence.closed === true && receipt?.data.unprepared === true
      && evidence.request_id === receipt.request_id && evidence.operation_id === receipt.operation_id
      && evidence.request_fingerprint === receipt.params_hash, 'Runner preparation closure does not match its fixed receipt');
    else check(evidence.request_id === undefined && evidence.operation_id === undefined && evidence.request_fingerprint === undefined,
      'Runner preparation absence evidence has an incomplete closure');
    await this.exclusive(() => current(this, options, binding.base_commit));
    return evidence;
  },

  async closeUnpreparedRemoteWorkspace(options) {
    check(options.agent_exited === true, 'unprepared cleanup requires Agent exit');
    const own = this.store.runnerReceipt(options.request_id);
    const before = this.store.assertRunnerUnprepared(options.identity.worker_id, own ? options.request_id : null);
    const value = { ...receiptIdentity(options), authorization_version: options.authorization_version };
    // Inspect before recording a new intent. Unknown accepted closes are never blindly replayed.
    let evidence = await this.inspectUnpreparedRemoteWorkspace(options);
    await this.exclusive(async () => {
      await current(this, options, before.base_commit);
      this.store.prepareUnpreparedRunnerCleanup(value, before.revision);
    });
    if (!evidence.closed) {
      guarded(this, options);
      evidence = await options.client.call('workspace.preparation.close', {}, { request_id: options.request_id });
      guarded(this, options);
    }
    return this.exclusive(async () => {
      await current(this, options, before.base_commit);
      return this.store.closeUnpreparedRunnerWorkspace(value, evidence, before.revision);
    });
  },

  async cleanupRemoteWorkspace(options) {
    request(options); oid(options.head_commit);
    const { task } = await this.exclusive(() => current(this, options, options.head_commit));
    check(options.agent_exited === true, 'remote cleanup requires Agent exit');
    let receipt = this.store.createRunnerReceipt({ ...receiptIdentity(options), kind: 'cleanup', authorization_version: options.authorization_version,
      params_hash: hash(stable({ head_commit: options.head_commit })), data: { head_commit: options.head_commit } });
    if (receipt.state === 'removed') return receipt;
    await barrier(this, options);
    if (receipt.state === 'prepared') receipt = update(this, options, 'removing');
    check(options.cleanup_attempt === undefined || typeof options.cleanup_attempt === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(options.cleanup_attempt), 'invalid explicit remote cleanup attempt');
    const phase = options.cleanup_attempt === undefined ? 'cleanup' : `cleanup-retry:${options.cleanup_attempt}`;
    const result = await call(this, options, 'workspace.cleanup', { steps: assertions(task.branch, options.head_commit, true, true) }, phase);
    if (!result.removed) return { receipt, ...result };
    return this.exclusive(async () => {
      await current(this, options, options.head_commit);
      return update(this, options, 'removed', { head_commit: options.head_commit, clean: true, stopped: true, removed: true });
    });
  },
};
