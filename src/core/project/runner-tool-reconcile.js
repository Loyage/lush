import { randomUUID } from 'node:crypto';
import { check, id } from '../types.js';
import { runnerIdentity, RUNNER_BINDING_KEYS } from '../runner-service.js';
import { toolOutcome } from '../runner-tool-journal.js';
import { runnerDirtyManifest } from '../runner-tool-evidence.js';
import { definitiveRunnerRejection, stable, hash } from '../../runner/protocol.js';

const stopped = value => value?.stopped === true && !value.busy && !value.truncated && !value.unknown;
const sameIdentity = (a, b) => [...RUNNER_BINDING_KEYS, 'run_id'].every(key => a[key] === b[key]);

/** User-only caller, under Project.write. Does not retry/resume or change Worker lifecycle.
 * Network awaits own only the logical sync gate; publication uses a short Git queue + DB CAS.
 */
export async function reconcileRunnerTools(project, workerId, expectedRevision) {
  workerId = id(workerId);
  const store = project.store, initial = store.runnerBinding(workerId), task = store.task(workerId);
  check(initial && Number.isSafeInteger(expectedRevision) && initial.revision === expectedRevision, 'Runner binding revision changed; reload before verification');
  check(['ready', 'unknown'].includes(initial.state) && task.workspace === null, 'Runner preparation/removal is not eligible for tool verification');
  const available = () => {
    check(!project.running.has(workerId) && !['running', 'queued'].includes(store.task(workerId).status)
      && !project.commandHookRunning?.has(workerId) && !project.taskMergeBusy?.has(workerId)
      && !project.workspaces.busy.has(workerId) && !project.activeTaskMerge(workerId)
      && !project.runnerStopJobs?.size, 'Runner is still active or stopping');
    for (let row = store.task(workerId); row; row = row.parent_id ? store.task(row.parent_id) : null)
      check(!project.acceptanceBusy?.has(row.id), 'Runner acceptance is in flight');
    const booking = task.reservation ? JSON.parse(task.reservation) : null;
    check(!booking || ['pending', 'integrated', 'withdrawn', 'completed', 'failed', 'cancelled'].includes(booking.status), 'Runner delivery is in flight');
  };
  available();
  project.taskSyncBusy ??= new Set();
  check(!project.taskSyncBusy.has(workerId), 'Runner verification/synchronization is already in flight');
  project.taskSyncBusy.add(workerId);
  let connection, checked = 0;
  const view = (reconciled, reason = null) => {
    const row = store.runnerBinding(workerId), barriers = store.runnerBarriers(workerId);
    return { worker_id: workerId, node_id: row.node_id, runner_id: row.runner_id, generation: row.generation,
      revision: row.revision, state: row.state, reconciled, blocked_reason: reason,
      checked, pending: barriers.runs.length + barriers.receipts.length + barriers.bindings.length };
  };
  try {
    const barriers = store.runnerBarriers(workerId);
    check(!store.pendingRunnerTaskSyncs(workerId).length && !barriers.receipts.some(row => row.kind !== 'tool'), 'Independent Runner delivery/object/cleanup barrier remains');
    const unresolvedRuns = barriers.runs;
    const latestRun = store.get('SELECT * FROM runner_runs WHERE worker_id=? ORDER BY run_id DESC LIMIT 1', workerId);
    // Retain the latest complete journal after release, including a lost verification ACK.
    // A released Run is evidence to inspect, never authorization to execute or release again.
    const runRows = unresolvedRuns.length ? unresolvedRuns : latestRun ? [latestRun] : [];
    const rows = store.all(`SELECT request_id FROM runner_receipts WHERE worker_id=? AND kind='tool'
      AND run_id=? ORDER BY rowid LIMIT 257`, workerId, runRows[0]?.run_id ?? -1)
      .map(row => store.runnerReceipt(row.request_id));
    check(rows.length <= 256 && runRows.length <= 1, 'Runner tool verification exceeds bounded history');
    check(barriers.receipts.every(row => rows.some(tool => tool.request_id === row.request_id)), 'Unresolved tool is outside its retained Run');
    check(initial.state !== 'unknown' || runRows.length > 0, 'Unknown workspace lacks a complete central tool journal');
    check(runRows.every(run => RUNNER_BINDING_KEYS.every(key => run[key] === initial[key])
      && run.tool_journal && JSON.parse(run.tool_journal).version === 1 && Number.isSafeInteger(run.tool_count)
      && run.tool_count === rows.filter(row => row.run_id === run.run_id).length), 'Legacy, missing or changed Run journal is incomplete');
    const identity = runnerIdentity(initial, { operation_id: randomUUID() });
    const receiptRevisions = rows.map(row => [row.request_id, row.revision]);
    const stamp = () => stable(store.get('SELECT count(*) AS n,max(rowid) AS last,sum(revision) AS revisions FROM runner_receipts WHERE worker_id=?', workerId));
    const receiptStamp = stamp();
    const guard = () => {
      available(); connection?.assertCurrent();
      const current = store.runnerBinding(workerId), liveTask = store.task(workerId);
      check(current.revision === initial.revision && RUNNER_BINDING_KEYS.every(key => current[key] === initial[key])
        && ['branch', 'target_branch', 'status', 'reservation', 'head_commit', 'workspace'].every(key => liveTask[key] === task[key]), 'Runner identity/state changed during verification');
      check(!store.pendingRunnerTaskSyncs(workerId).length
        && !store.runnerBarriers(workerId).receipts.some(row => row.kind !== 'tool'), 'Independent Runner barrier appeared during verification');
      check(stamp() === receiptStamp && runRows.every(run => store.runnerRun(run.run_id)?.revision === run.revision)
        && receiptRevisions.every(([key, revision]) => store.runnerReceipt(key)?.revision === revision), 'Runner receipts changed during verification');
      check(store.runnerBarriers(workerId).runs.length === unresolvedRuns.length, 'Runner Run changed during verification');
      project.runners.assertBinding(identity, { observation: true });
    };
    guard();
    connection = await project.runners.connect(identity, { observation: true });
    const call = async (method, params = {}) => { guard(); const value = await connection.client.call(method, params); guard(); return value; };
    const workspace = await call('workspace.inspect');
    const latest = store.get('SELECT max(run_id) AS id FROM runner_runs WHERE worker_id=?', workerId)?.id ?? 0;
    check(workspace.last_run_id === latest, 'Runner has an unowned or missing invocation generation');
    // This is fixed-authority stop, not replay of an old code operation. No live central
    // invocation exists, and latest Run / binding were checked before revoking that lease.
    check(stopped(await call('lease.revoke')), 'Runner has not confirmed stop');
    const patches = new Map(), histories = new Map(), fileHeads = new Map();
    for (const row of rows) {
      const file = row.data.method.startsWith('file.');
      if (row.terminal && (row.state === 'rejected' || !file && histories.has(row.run_id))) continue;
      const status = await call('request.status', { request_id: row.request_id }); checked++;
      check(status.request_id === row.request_id && sameIdentity(status.identity ?? {}, row)
        && status.method === row.data.method && status.fingerprint === row.params_hash, 'Runner request evidence identity/digest mismatch');
      const history = status.history;
      check(history && Array.isArray(history.requests) && !history.truncated && history.total === history.requests.length
        && new Set(history.requests.map(item => item.request_id)).size === history.total && history.total <= 256, 'Runner request history is incomplete');
      for (const entry of history.requests) {
        const central = rows.find(item => item.run_id === row.run_id && item.request_id === entry.request_id);
        check(central && central.params_hash === entry.fingerprint && central.data.method === entry.method, 'Runner has an unjournaled tool operation');
      }
      check(rows.filter(item => item.run_id === row.run_id && item.state !== 'rejected')
        .every(item => history.requests.some(entry => entry.request_id === item.request_id)), 'Runner lost a fixed request receipt');
      histories.set(row.run_id, history);
      if (row.terminal) {
        if (file) {
          check(status.state === 'completed' && !status.error, 'Recorded file outcome disagrees with Runner');
          const outcome = toolOutcome(row, status.result);
          check(outcome.evidence.digest === row.evidence.digest, 'Recorded file digest changed');
          fileHeads.set(row.data.path_hash, { path: status.result.path, digest: outcome.evidence.digest });
        }
        continue;
      }
      check(['completed', 'failed'].includes(status.state), 'Runner request outcome remains unknown');
      check((status.state === 'failed') === Boolean(status.error), 'Runner outcome fields disagree');
      if (status.error) {
        check(definitiveRunnerRejection({ ...status.error, runner_response: true }), 'Runner failure has unknown effects');
        patches.set(row.request_id, { state: 'rejected', evidence: { verified: true } });
      } else if (row.data.method.startsWith('command.')) {
        const execution_id = status.result?.execution_id ?? row.data.execution_id;
        check(typeof execution_id === 'string', 'Runner command receipt is incomplete');
        const command = await call('command.status', { execution_id });
        check(command.execution_id === execution_id && command.stop_confirmed === true && command.state === 'exited', 'Runner command stop remains unknown');
        patches.set(row.request_id, toolOutcome(row, command));
      } else {
        const outcome = toolOutcome(row, status.result);
        patches.set(row.request_id, outcome);
        fileHeads.set(row.data.path_hash, { path: status.result.path, digest: outcome.evidence.digest });
      }
    }
    const options = { client: connection.client, identity, request_id: randomUUID(), require_no_lease: true, guard };
    const observed = await project.workspaces.inspectRemoteWorkspace(options);
    check(observed.head_commit === initial.head_commit, 'Runner HEAD differs from its fixed central tip');
    const manifest = await runnerDirtyManifest(connection.client, task.branch, initial.head_commit, guard);
    check(manifest !== null, 'Runner dirty ownership evidence is incomplete');
    const journal = runRows[0] ? JSON.parse(runRows[0].tool_journal) : null;
    if (Object.keys(manifest).length || fileHeads.size || Object.keys(journal?.baseline ?? {}).length) {
      check(runRows.length === 1 && (histories.has(runRows[0].run_id) || runRows[0].tool_count === 0), 'Dirty workspace lacks complete invocation history');
      check(journal.baseline !== null, 'Dirty workspace had no verifiable invocation baseline');
      const expected = Object.assign(Object.create(null), journal.baseline);
      for (const [key, file] of fileHeads) {
        const current = await call('file.read', { path: file.path, format: 'base64', limit: 1 });
        check(current.sha256 === file.digest, 'Journaled file changed or disappeared');
        expected[key] = file.digest;
      }
      const actual = Object.fromEntries(Object.entries(manifest).map(([path, digest]) => [hash(path), digest]));
      check(Object.entries(actual).every(([key, digest]) => expected[key] === digest)
        && Object.entries(expected).every(([key, digest]) => actual[key] === digest || fileHeads.get(key)?.digest === digest),
        'Dirty changes or missing files cannot be attributed to the fixed journal');
    }
    check((await call('workspace.inspect')).last_run_id === latest, 'Runner invocation epoch changed during verification');
    check(stopped(await call('workspace.barrier')), 'Runner became busy during verification');
    const after = await runnerDirtyManifest(connection.client, task.branch, initial.head_commit, guard);
    check(stable(after) === stable(manifest), 'Runner dirty evidence changed during verification');
    await project.workspaces.exclusive(async () => {
      check(await project.workspaces.git(project.config.project, 'rev-parse', '--verify', `refs/heads/${task.branch}`) === initial.head_commit,
        'Central Runner ref changed during verification');
      guard();
      store.transaction(() => {
        guard();
        for (const row of rows) if (patches.has(row.request_id)) store.updateRunnerReceipt({ ...runnerIdentity(row, { run_id: row.run_id }), request_id: row.request_id }, patches.get(row.request_id), row.revision);
        for (const run of unresolvedRuns) store.releaseRunnerRun(runnerIdentity(run, { run_id: run.run_id }), run.revision, { stopped: true });
        if (initial.state === 'unknown') store.confirmRunnerWorkspace(runnerIdentity(initial), initial.head_commit, initial.revision);
        store.event(workerId, 'runner.tools_reconciled', { checked, generation: initial.generation, dirty_preserved: Object.keys(manifest).length > 0 });
      });
    });
    return view(true);
  } catch { return view(false, 'evidence_incomplete_or_changed'); }
  finally { try { await connection?.close(); } finally { project.taskSyncBusy.delete(workerId); } }
}
