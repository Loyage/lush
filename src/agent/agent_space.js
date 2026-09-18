/**
 * The runtime agent space: the live workers of one daemon run.
 *
 * An agent is "whoever is working for a process right now", not a logical
 * process: it has no pid of its own and is never persisted. Each one gets an
 * id `PID.N` (N minted per daemon run and per process), finished ones are kept
 * in a bounded in-memory log so `agents list --all` can answer "what just
 * ran?", and the durable record of the same work is the `agent_calls` row.
 *
 * Every function here operates on a live `AgentRuntime` (its maps plus the
 * repository and provider it holds); the class in `runtime.js` is the only
 * caller.
 */
import { LushError } from '../core/types.js';

/** Finished agents kept in memory for `process agents list --all`; cleared on daemon exit. */
export const AGENT_LOG_LIMIT = 32;

/** Seconds-resolution duration for the CLI's agent lines. */
export function elapsedMs(record) {
  const end = record.ended_at === undefined ? Date.now() : Date.parse(record.ended_at);
  return Math.max(0, end - Date.parse(record.started_at));
}

/** `PID.N` sorts by pid, then by the order the agent was minted. */
export function byAgentId(left, right) {
  return Number(left.id.split('.')[0]) - Number(right.id.split('.')[0])
    || Number(left.id.split('.')[1]) - Number(right.id.split('.')[1]);
}

/**
 * SIGKILL one OS process. `false` means the pid was already gone (ESRCH) — an
 * agent whose pi exited on its own is not a failure, just nothing to signal.
 */
function killProcess(osPid) {
  try {
    process.kill(osPid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

/**
 * Mint the next agent id for `pid` (`PID.N`) and register the live worker.
 * N is per process and per daemon run: ids are runtime identities — the
 * durable identity of the same work is the call row (`agent_calls.id`).
 * The provider instance is kept on the record (never serialized) so later
 * reads (`agents show`) can ask *that* agent about its session, even if the
 * profile file changed in the meantime.
 */
export function openAgent(runtime, pid, callId, { interactive = false, provider = runtime.provider } = {}) {
  const seq = (runtime.agentSeq.get(pid) ?? 0) + 1;
  runtime.agentSeq.set(pid, seq);
  const record = {
    id: `${pid}.${seq}`,
    pid,
    provider: provider.name,
    impl: provider,
    call_id: callId,
    status: 'running',
    started_at: new Date().toISOString(),
    os_pid: null,
    interactive,
  };
  runtime.agents.set(record.id, record);
  return record;
}

/** The OS process behind a live agent (daemon-spawned pi, or a reported terminal one). */
export function noteOsPid(record, osPid) {
  if (record && record.status === 'running') record.os_pid = osPid;
}

/** Move a finished worker out of the live map into the bounded in-memory log. */
export function closeAgent(runtime, record, status, error = null) {
  if (!record || !runtime.agents.has(record.id)) return;
  record.status = status;
  record.ended_at = new Date().toISOString();
  if (error !== null) record.error = error;
  runtime.agents.delete(record.id);
  runtime.agentLog.unshift(record);
  if (runtime.agentLog.length > AGENT_LOG_LIMIT) runtime.agentLog.length = AGENT_LOG_LIMIT;
}

/** One worker as the CLI sees it: identity plus liveness, never a logical Process. */
export function agentView(runtime, record) {
  const running = record.status === 'running';
  // `process agents list --all` keeps finished records for this daemon run, and
  // `process delete` may have removed the process they belong to: the name is
  // then simply unknown, which must not make the whole listing fail.
  const process = runtime.repository.exists(record.pid) ? runtime.repository.get(record.pid) : null;
  return {
    id: record.id,
    pid: record.pid,
    name: process === null ? null : process.name,
    provider: record.provider,
    status: record.status,
    call_id: record.call_id,
    interactive: record.interactive,
    // A daemon-spawned agent is interruptible through the runtime; an
    // interactive one only once its terminal reported the OS pid.
    cancellable: running && (!record.interactive || record.os_pid !== null),
    os_pid: record.os_pid,
    started_at: record.started_at,
    ended_at: record.ended_at ?? null,
    elapsed_ms: elapsedMs(record),
    error: record.error ?? null,
  };
}

/**
 * Live workers (`process agents list`), plus this daemon run's finished ones
 * when `all` is set. Deliberately runtime data: a restarted daemon has no
 * agents, and the durable record of the same work is its call row.
 */
export function agentsList(runtime, { pid = null, all = false } = {}) {
  const keep = (record) => pid === null || record.pid === pid;
  const live = [...runtime.agents.values()].filter(keep).sort(byAgentId)
    .map((record) => agentView(runtime, record));
  if (!all) return live;
  const finished = runtime.agentLog.filter(keep).sort(byAgentId).map((record) => agentView(runtime, record));
  return [...live, ...finished];
}

/** One agent: its runtime facts, the session it writes into, and its durable call row. */
export function agentShow(runtime, id) {
  const record = runtime.agents.get(id) ?? runtime.agentLog.find((candidate) => candidate.id === id);
  if (record === undefined) throw new LushError(`agent not found: ${id}`, -32004);
  const call = runtime.repository.callById(record.call_id);
  const provider = record.impl ?? runtime.provider;
  const sessions = typeof provider.sessions === 'function' ? provider.sessions(record.pid) : null;
  const files = sessions?.files ?? [];
  return {
    ...agentView(runtime, record),
    session: sessions === null ? null : {
      session_dir: sessions.session_dir,
      session_id: sessions.session_id,
      files,
      file: files.length ? files[files.length - 1] : null,
    },
    call: call === null ? null : {
      id: call.id,
      prompt: call.prompt,
      status: call.status,
      output: call.output,
      error: call.error,
      started_at: call.started_at,
      finished_at: call.finished_at,
    },
  };
}

/**
 * Kill one live worker: the invocation ends as interrupted, the logical
 * process is untouched (that is `process kill PID`).
 *
 * How the OS side fared is reported as `outcome`:
 *
 * - `killed`: the worker had an OS pid and it took the SIGKILL.
 * - `gone`: it had one, but the process was already dead (ESRCH), so the
 *   terminal's pi exited on its own and there was nothing to signal.
 * - `no_pid`: nothing to signal — an in-process provider, or an interactive
 *   agent whose terminal has not reported its pi's pid yet.
 *
 * A daemon-spawned pi settles itself when the abort reaches its tool loop. An
 * interactive call has no daemon-side code to abort — its terminal is the only
 * witness — so once its OS process is gone (`killed` or `gone`) the daemon
 * settles the call here rather than leaving the worker listed until the call
 * timeout fires. With `no_pid` there is no such evidence, so the entry is only
 * marked and waits for the terminal to report back (or for the timeout).
 */
export function agentsKill(runtime, id) {
  const record = runtime.agents.get(id);
  const entry = record === undefined ? undefined : runtime.active.get(record.pid);
  if (record === undefined || entry === undefined || entry.agent !== record) {
    throw new LushError(`agent ${id} is not running`, -32009);
  }
  entry.reason = 'cancelled';
  const outcome = record.os_pid === null ? 'no_pid' : (killProcess(record.os_pid) ? 'killed' : 'gone');
  entry.controller.abort();
  if (record.interactive && outcome !== 'no_pid') {
    runtime._settle(entry.pid, entry, 'interrupted', { error: `invocation ${entry.callId} interrupted` });
  }
  return { ...agentView(runtime, record), outcome };
}

/**
 * Live-worker summary for one process, used by `process tree`: how many agents
 * are running and who they are. No Context, no argv, no session walk — the
 * tree answers "who is working right now", the session answers "what is on
 * disk", and both stay cheap.
 */
export function agentSummary(runtime, pid, profile = undefined) {
  const running = [...runtime.agents.values()].filter((record) => record.pid === pid).sort(byAgentId);
  return {
    provider: runtime.providerName(pid, profile),
    running: running.length,
    agents: running.map((record) => ({
      id: record.id,
      call_id: record.call_id,
      interactive: record.interactive,
      os_pid: record.os_pid,
      started_at: record.started_at,
      elapsed_ms: elapsedMs(record),
    })),
  };
}
