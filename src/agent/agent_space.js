/**
 * The runtime agent space: the live workers of one daemon run.
 *
 * An agent is "whoever is working on a task right now": it is not a service and
 * is never persisted. Its id is `TASK.N` — the task it serves and the N-th
 * agent that task has run in this daemon (a task that was woken again after its
 * children settled gets a new N). Finished ones are kept in a bounded in-memory
 * log so `task agents list --all` can answer "what just ran?", and the durable
 * record of the same work is the `agent_calls` row.
 *
 * Every function here operates on a live `AgentRuntime` (its maps plus the
 * repository and provider it holds); the class in `runtime.js` is the only
 * caller.
 */
import { LushError } from '../core/types.js';

/** Finished agents kept in memory for `task agents list --all`; cleared on daemon exit. */
export const AGENT_LOG_LIMIT = 32;

/** Seconds-resolution duration for the CLI's agent lines. */
export function elapsedMs(record) {
  const end = record.ended_at === undefined ? Date.now() : Date.parse(record.ended_at);
  return Math.max(0, end - Date.parse(record.started_at));
}

/** `TASK.N` sorts by task, then by the order the agent was minted. */
export function byAgentId(left, right) {
  return Number(left.id.split('.')[0]) - Number(right.id.split('.')[0])
    || Number(left.id.split('.')[1]) - Number(right.id.split('.')[1]);
}

/**
 * SIGKILL one OS process. `false` means the PID was already gone (ESRCH) — an
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
 * Mint the next agent id for `taskId` (`TASK.N`) and register the live worker.
 * N is per task and per daemon run: ids are runtime identities — the durable
 * identity of the same work is the call row (`agent_calls.id`).
 */
export function openAgent(runtime, taskId, sid, callId, { interactive = false, provider = runtime.provider } = {}) {
  const key = String(taskId);
  const seq = (runtime.agentSeq.get(key) ?? 0) + 1;
  runtime.agentSeq.set(key, seq);
  const record = {
    id: `${taskId}.${seq}`,
    task_id: taskId,
    sid,
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

/** One worker as the CLI sees it: identity plus liveness, never a logical Service. */
export function agentView(runtime, record) {
  const running = record.status === 'running';
  // `task agents list --all` keeps finished records for this daemon run, and the
  // service or task they belong to may have been deleted since: unknown names
  // must not make the whole listing fail.
  const service = runtime.repository.exists(record.sid) ? runtime.repository.get(record.sid) : null;
  const task = runtime.repository.findTask(record.task_id);
  return {
    id: record.id,
    task_id: record.task_id,
    sid: record.sid,
    name: service === null ? null : service.name,
    task_status: task === null ? null : task.status,
    goal: task === null ? null : task.goal,
    provider: record.provider,
    status: record.status,
    call_id: record.call_id,
    interactive: record.interactive,
    // A daemon-spawned agent is interruptible through the runtime; an
    // interactive one only once its terminal reported the OS PID.
    cancellable: running && (!record.interactive || record.os_pid !== null),
    os_pid: record.os_pid,
    started_at: record.started_at,
    ended_at: record.ended_at ?? null,
    elapsed_ms: elapsedMs(record),
    error: record.error ?? null,
  };
}

/**
 * Live workers (`task agents list`), plus this daemon run's finished ones when
 * `all` is set. Deliberately runtime data: a restarted daemon has no agents,
 * and the durable record of the same work is its call row.
 */
export function agentsList(runtime, { taskId = null, sid = null, all = false } = {}) {
  const keep = (record) => (taskId === null || record.task_id === taskId)
    && (sid === null || record.sid === sid);
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
  const sessions = typeof provider.sessions === 'function' ? provider.sessions(record.task_id) : null;
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
 * Kill one live worker: the invocation ends as interrupted and its task is
 * cancelled (a task whose agent was force-killed has no answer to record).
 *
 * How the OS side fared is reported as `outcome`:
 *
 * - `killed`: the worker had an OS PID and it took the SIGKILL.
 * - `gone`: it had one, but the process was already dead (ESRCH), so the
 *   terminal's pi exited on its own and there was nothing to signal.
 * - `no_pid`: nothing to signal — an in-service provider, or an interactive
 *   agent whose terminal has not reported its pi's PID yet.
 */
export function agentsKill(runtime, id) {
  const record = runtime.agents.get(id);
  const entry = record === undefined ? undefined : runtime.active.get(record.task_id);
  if (record === undefined || entry === undefined || entry.agent !== record) {
    throw new LushError(`agent ${id} is not running`, -32009);
  }
  entry.reason = 'cancelled';
  const outcome = record.os_pid === null ? 'no_pid' : (killProcess(record.os_pid) ? 'killed' : 'gone');
  entry.controller.abort();
  // The task an agent was force-killed for has no answer to record, so it ends
  // as cancelled — whether the abort reaches a daemon-run tool loop (which
  // would otherwise report a failure) or only a terminal that never came back.
  if (record.interactive && outcome !== 'no_pid') {
    runtime._settle(entry, 'interrupted', { error: `invocation ${entry.callId} interrupted` });
  }
  runtime.manager.cancelTask(record.task_id);
  return { ...agentView(runtime, record), outcome };
}

/**
 * Live-worker summary for one service, used by `service tree`: how many agents
 * are running there and who they are. No Context, no argv, no session walk —
 * the tree answers "who is working right now", the session answers "what is on
 * disk", and both stay cheap.
 */
export function agentSummary(runtime, sid, profile = undefined) {
  const running = [...runtime.agents.values()].filter((record) => record.sid === sid).sort(byAgentId);
  return {
    provider: runtime.providerName(sid, profile),
    running: running.length,
    agents: running.map((record) => ({
      id: record.id,
      task_id: record.task_id,
      call_id: record.call_id,
      interactive: record.interactive,
      os_pid: record.os_pid,
      started_at: record.started_at,
      elapsed_ms: elapsedMs(record),
    })),
  };
}
