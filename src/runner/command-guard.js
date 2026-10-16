import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { RunnerStore } from './store.js';
import { createCgroupController, commandGroupName } from './cgroup.js';
import { appendOutput, authorityActive, executionRow, finishExecution } from './command-state.js';
import { observeBootstrap } from './command-bootstrap.js';
import { check } from './protocol.js';
import { beginCommandResources, beginContainmentCreation, recordCommandContainment, createCommandHome,
  resourceRow, verifyCommandHome } from './command-resources.js';

export function productionController(spec) {
  const controller = createCgroupController({ cgroup_root: spec.cgroup_root, node_id: spec.node_id });
  return { ...controller, launch(receipt, spec, workspace, home, onBootstrap) {
    const payload = JSON.stringify({ receipt, spec, workspace, home }) + '\n';
    const child = spawn(process.execPath, [fileURLToPath(new URL('./command-child.js', import.meta.url))], {
      env: { PATH: '/usr/bin:/bin', HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Capture the live handle before any later initialization can throw.
    onBootstrap(child);
    child.stdin.on('error', () => {});
    child.stdin.end(payload);
    return child;
  } };
}

/** Independent watchdog. Injected controllers are test-only programmatic seams, never CLI/env options. */
export async function runCommandGuard({ root, execution_id, controller: injected, input = process.stdin }) {
  const store = new RunnerStore(root);
  let child, bootstrap, receipt, row, controller, timer, spec;
  let launchAttempted = false, ioFailure = false, stoppingReason = null, stopResolve;
  const stopRequested = new Promise(resolve => { stopResolve = resolve; });
  const requestStop = reason => { stoppingReason ??= reason; stopResolve(); };
  const onEOF = () => requestStop('disconnected');
  input.on('end', onEOF); input.on('error', onEOF); input.resume();
  const onTerm = () => requestStop('guard_stopped');
  process.on('SIGTERM', onTerm); process.on('SIGINT', onTerm);
  const persistSpec = () => store.db.query('UPDATE executions SET spec_json=? WHERE execution_id=?').run(JSON.stringify(spec), execution_id);
  const ownBootstrap = owned => {
    check(!child || child === owned, 'UNKNOWN', 'Unexpected second bootstrap');
    if (bootstrap) return;
    child = owned;
    bootstrap = observeBootstrap(child, (stream, data) => {
      try { appendOutput(store, execution_id, stream, data); }
      catch { ioFailure = true; requestStop('output_error'); }
    });
  };
  const stopOwned = async () => {
    if (launchAttempted) {
      // A temporarily empty cgroup cannot prove this outside-group bootstrap won't attach later.
      check(bootstrap, 'UNKNOWN', 'Bootstrap ownership is not confirmed');
      await bootstrap.terminate();
      spec.bootstrap_state = 'exited'; persistSpec();
    } else {
      spec.bootstrap_state = 'not_started'; persistSpec();
    }
    await controller.stop(receipt);
    check(!controller.populated(receipt), 'UNKNOWN', 'Containment still populated');
    const resources = resourceRow(store, execution_id);
    if (resources?.home_state === 'present') verifyCommandHome(store, row, resources);
    else check(resources?.home_state === 'absent', 'UNKNOWN', 'Command home creation is unconfirmed');
  };
  try {
    let workspace;
    row = store.transaction(() => {
      const fresh = executionRow(store, execution_id);
      check(fresh && !fresh.stop_confirmed && ['starting', 'stopping'].includes(fresh.state)
        && fresh.cgroup_name === commandGroupName(fresh), 'UNKNOWN', 'Invalid command claim');
      workspace = store.db.query('SELECT * FROM workspaces WHERE workspace_key=?').get(fresh.workspace_key);
      check(workspace && workspace.busy_request === fresh.request_id, 'UNKNOWN', 'Command workspace ownership changed');
      spec = JSON.parse(fresh.spec_json);
      // Claim BEFORE any containment/home/bootstrap effects. A late or duplicate guard cannot
      // treat an earlier guard's starting/stopping row as proof that nothing was launched.
      check(fresh.started_at === null && !spec.guard_claim && !spec.containment && !spec.bootstrap_state,
        'UNKNOWN', 'Command guard was already initialized');
      // The unallocated resource ledger belongs to the same exclusive claim. Early
      // cancellation must remain safely reclaimable, without adopting prior resources.
      beginCommandResources(store, fresh);
      spec.guard_claim = randomUUID(); persistSpec();
      return fresh;
    });
    controller = injected ?? productionController(spec);
    controller.preflight();
    const stoppedBeforePrepare = store.transaction(() => {
      const fresh = executionRow(store, execution_id);
      check(fresh && !fresh.stop_confirmed && ['starting', 'stopping'].includes(fresh.state), 'UNKNOWN', 'Command claim changed');
      if (fresh.state === 'stopping') requestStop(fresh.reason ?? 'cancelled');
      else if (input.readableEnded) requestStop('disconnected');
      else if (!authorityActive(store, fresh)) requestStop('revoked');
      if (!stoppingReason) return false;
      // This exclusively claimed guard has not even prepared containment. Persist that
      // proof and the stop receipt together; state='stopping' alone is never enough.
      spec.bootstrap_state = 'not_started'; persistSpec();
      finishExecution(store, fresh, { reason: stoppingReason, stop_confirmed: true });
      return true;
    });
    if (stoppedBeforePrepare) return;
    beginContainmentCreation(store, row);
    receipt = controller.prepare(row);
    // Persist ownership before launch. Pending stays durable even if a subsequent launch transaction rolls back.
    spec = { ...spec, containment: receipt, bootstrap_state: 'not_started' }; persistSpec();
    recordCommandContainment(store, row, receipt);
    const home = createCommandHome(store, row);
    spec.bootstrap_state = 'pending'; persistSpec();
    let launched = false;
    store.transaction(() => {
      const fresh = executionRow(store, execution_id);
      check(fresh && !fresh.stop_confirmed && ['starting', 'stopping'].includes(fresh.state), 'UNKNOWN', 'Command claim changed before launch');
      if (fresh.state === 'stopping') requestStop(fresh.reason ?? 'cancelled');
      else if (!authorityActive(store, fresh)) requestStop('revoked');
      if (fresh.state !== 'starting' || stoppingReason) return;
      launchAttempted = true;
      const owned = controller.launch(receipt, spec, workspace, home, ownBootstrap);
      ownBootstrap(owned); // Compatibility for test controllers that only return their handle.
      launched = true;
      store.db.query("UPDATE executions SET state='running',started_at=? WHERE execution_id=? AND state='starting'").run(Date.now(), execution_id);
    });
    if (!launched) {
      await stopOwned();
      finishExecution(store, row, { reason: stoppingReason ?? 'cancelled', stop_confirmed: true });
      return;
    }
    // Fixture controllers may record a test process-group identity; production never persists a PID.
    if (injected) { persistSpec(); recordCommandContainment(store, row, receipt); }
    const began = Date.now();
    const checkStop = () => {
      const fresh = executionRow(store, execution_id);
      if (!fresh || fresh.state === 'unknown') requestStop('unknown');
      else if (fresh.state === 'stopping') requestStop(fresh.reason ?? 'cancelled');
      else if (!authorityActive(store, fresh)) requestStop('revoked');
      else if (Date.now() - began >= spec.command_ms) requestStop('timeout');
    };
    timer = setInterval(() => { try { checkStop(); } catch { requestStop('watchdog_error'); } }, 25);
    checkStop();
    const outcome = await Promise.race([bootstrap.outcome, stopRequested.then(() => ({ code: null, reason: stoppingReason }))]);
    await stopOwned();
    const drained = await bootstrap.drain();
    // After a drain timeout, discard later events; never leave appendOutput referencing a closed Store.
    bootstrap.detachOutput();
    finishExecution(store, row, { reason: outcome.reason, exit_code: outcome.code,
      stop_confirmed: true, output_complete: drained && !ioFailure,
      unknown: ['unknown', 'watchdog_error'].includes(outcome.reason) });
  } catch {
    let confirmed = false;
    try {
      if (controller && receipt) { await stopOwned(); confirmed = true; }
    } catch {
      // Best-effort containment kill is still useful, but cannot replace missing bootstrap exit proof.
      try { if (controller && receipt) await controller.stop(receipt); } catch { /* Remains unknown. */ }
    }
    if (row) finishExecution(store, row, { reason: 'guard_error', stop_confirmed: confirmed, output_complete: false, unknown: true });
  } finally {
    clearInterval(timer);
    bootstrap?.detachOutput();
    input.removeListener('end', onEOF); input.removeListener('error', onEOF);
    process.removeListener('SIGTERM', onTerm); process.removeListener('SIGINT', onTerm);
    input.pause(); store.close();
  }
}

if (import.meta.main) {
  const lines = createInterface({ input: process.stdin });
  let started = false;
  lines.once('line', line => {
    if (started) return; started = true;
    try {
      if (Buffer.byteLength(line) > 8192) throw new Error('oversize');
      const { root, execution_id } = JSON.parse(line);
      void runCommandGuard({ root, execution_id }).then(() => process.exit(0), () => process.exit(1));
    } catch { process.exit(1); }
  });
  lines.once('close', () => { if (!started) process.exit(1); });
}
