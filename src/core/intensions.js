/**
 * The intension queue: raw user input, and the one parser that turns it into
 * work.
 *
 * Lush has exactly one way in for a human. They say something — `lush intent
 * submit '<原话>' [--sid N]` — and that text becomes an **intension**: their
 * words verbatim, plus the service they named (or none). Nothing is decided at
 * that moment: the row is stored, and the queue moves on its own.
 *
 * The queue is serial by construction. Parsing happens in a *root task on the
 * parsing node* (SID 0 — the only node that can see the whole architecture),
 * and a service runs one task at a time (`core/tasks/rules.js`), so exactly one
 * intension is being parsed at any moment while everything else waits in
 * `queued`, oldest first. This file is the only place in Lush that creates a
 * root task; every other task is a child of one, delegated downward, which is
 * what makes `lush task tree` trace a piece of user input all the way out.
 *
 * What a parser does with a row (it reads `context()` for the facts):
 *
 *   no conflict → arrange it: delegate downstream with `task_construct` (the
 *                 normal path) or answer directly, then `settle` — which hands
 *                 the delegated subtree over so this task can end;
 *   conflict    → `notice` with a choice form, and the row parks in `awaiting`
 *                 with that notice. The answer arrives as the parse task's next
 *                 input, and the decision is taken then — never guessed.
 *
 * A submission may also ask to *hold* the parse task so a human can run its agent
 * in their own terminal (`lush intent submit --interactive`): the parse task is
 * created but not started, and the caller drives it (see
 * `agent/runtime/interactive.js`).
 *
 * The mechanical half of "conflict" needs no judgement: a busy service, a
 * singleton that already exists, a template its parent may not create, a node
 * that is not active — the layer's own guards already refuse those, and the
 * parser turns the refusal into a question. The rest ("this contradicts how the
 * architecture is meant to be used", "this duplicates a running task") is a
 * reading of `context()`, which is why that read model carries the templates,
 * the service tree and the open queue rather than a summary of anything the
 * parser remembers from last time.
 *
 * The rules that hold this together:
 *
 * - one row per parse: `beginParsing` links the row to its task, `attempts`
 *   counts the tries, and a parse task that dies without settling releases the
 *   row back into the queue until `MAX_ATTEMPTS`, after which the row is
 *   *rejected* with the reason. A user's words are never dropped in silence.
 * - a closed row is final: `settle` refuses to move a settled or rejected row.
 * - closing the row hands the subtree off: a parse task that has concluded does
 *   not own the work it arranged any more (`handoff`), so it can finish at once
 *   and the node is free for the next input while that work keeps running.
 * - the answer of a parse task *is* the intension's response: when the task
 *   finishes, `completedTask` closes the row with its result and the tasks it
 *   arranged — whether the agent called `task_complete` or simply answered. A
 *   parse that ended any other way goes back into the queue, so a prompt slip
 *   cannot lose input either.
 * - `defer` is the user's "let that task finish first": the row goes back to
 *   `queued` behind `blocked_by_task_id`, and `drain` skips it until that task
 *   is finished. It is the one conflict answer that makes no new task.
 * - the conflict conversation is a notice like any other. `notices.intension_id`
 *   is the edge, written by `attachNotice` when a parse task reports — so
 *   `intent show` can point at the question, and the question at the input.
 *
 * Everything operates on the `ServiceManager` passed in; the RPC / CLI / agent
 * tool signatures are one level up, in `service_manager/intensions.js`.
 */
import { LushError, text, validSid } from './types.js';
import { INTENSION_STATUSES } from './lifecycle.js';
import * as tasks from './tasks.js';
import { summary as taskSummary } from './tasks/read.js';

/**
 * The parsing node. SID 0 is the root service, the only node whose children are
 * whatever the architecture currently allows, and the only one whose prompt is
 * refreshed from the loaded template at every daemon start — it is therefore
 * the only place that can decide *what the architecture should do with this*.
 */
export const INTENSION_NODE_SID = 0;

/** How many times one row may be handed to a parser before it is refused. */
export const MAX_ATTEMPTS = 3;

const MAX_CONTENT = 20_000;
const MAX_SOURCE = 32;
const MAX_RESPONSE = 20_000;
const MAX_REASON = 2_000;

/** A closed row: `settled` (arranged / answered) or `rejected` (refused, withdrawn, exhausted). */
function isClosed(intension) {
  return intension.status === 'settled' || intension.status === 'rejected';
}

function requireIntension(manager, intensionId) {
  validSid(intensionId);
  return manager.repository.getIntension(intensionId);
}

/**
 * Which row a caller means. The parser names its own task (the CLI and the
 * agent tools fill it in from their identity), which is the only handle it is
 * guaranteed to have; everyone else names the row.
 */
function resolve(manager, { intensionId = null, fromTaskId = null }) {
  if (intensionId !== null && intensionId !== undefined) return requireIntension(manager, intensionId);
  if (fromTaskId === null || fromTaskId === undefined) {
    throw new LushError('name the intension: pass intension_id, or from_task_id for the task parsing one', -32602);
  }
  const row = manager.repository.openIntensionOfTask(fromTaskId);
  if (row === null) {
    throw new LushError(`task ${fromTaskId} is not parsing an intension`, -32010);
  }
  return row;
}

// ── In ─────────────────────────────────────────────────────────────────────

/**
 * Record one piece of user input and push the queue. The `sid` is a *hint*: it
 * is checked for existence (a typo is a usage error, not a conflict to decide
 * about) but nothing is done with it here — whether it is the right target is
 * exactly what parsing decides.
 *
 * `hold` creates the parse task without starting it, for a caller that will run
 * its agent itself (the interactive handover).
 */
export function submit(manager, { content, sid = null, source = 'rpc', hold = false }) {
  text(content, 'content', MAX_CONTENT);
  if (source !== null && source !== undefined) text(source, 'source', MAX_SOURCE);
  if (sid !== null) {
    validSid(sid);
    manager.repository.get(sid); // a missing service reports -32004
  }
  const row = manager.repository.createIntension({ sid, content, source: source ?? 'rpc' });
  drain(manager, { hold });
  return manager.repository.getIntension(row.id);
}

/** Retract a row that has not started parsing yet. */
export function withdraw(manager, intensionId, reason = null) {
  const row = requireIntension(manager, intensionId);
  if (row.status !== 'queued') {
    throw new LushError(`intension ${row.id} is ${row.status}; only a queued intension can be withdrawn`, -32010);
  }
  if (reason !== null && reason !== undefined) text(reason, 'reason', MAX_REASON);
  const closed = close(manager, row.id, {
    status: 'rejected',
    resolution: { kind: 'withdrawn', reason: reason ?? null },
    response: null,
  });
  drain(manager);
  return closed;
}

// ── The queue ──────────────────────────────────────────────────────────────

/**
 * Start the next parse, if anything may start. This is the only creator of root
 * tasks in Lush, and it is called from three places: a submission, a task
 * reaching a terminal status (`afterTaskSettled`), and daemon start (rows the
 * previous daemon left behind).
 *
 * Serial for free: the parsing node runs one task at a time, so a busy node
 * ends the drain right here and the rest of the queue stays `queued`.
 *
 * `hold` stops one step short of the end: the parse task is created but not
 * started, and the caller runs it (the interactive handover).
 */
export function drain(manager, { hold = false } = {}) {
  if (!canParse(manager)) return null;
  const pending = manager.repository.nextQueuedIntension();
  if (pending === null) return null;
  // `start: false` first: the row must be linked to the task before the agent
  // can look at it, or the parser would see an intension that nobody is parsing.
  const task = tasks.construct(manager, {
    parentTaskId: null,
    sid: INTENSION_NODE_SID,
    goal: parseGoal(pending),
    start: false,
    intensionId: pending.id,
  });
  const row = manager.repository.beginIntensionParsing(pending.id, task.id);
  manager.repository.taskEvent(task.id, 'intension', {
    intension_id: row.id, sid: row.sid, attempt: row.attempts,
  });
  if (!hold) manager.runtime.startTask(task.id);
  return { intension: row, task };
}

function canParse(manager) {
  if (manager.runtime === null || manager.runtime.closing) return false;
  if (!manager.repository.exists(INTENSION_NODE_SID)) return false;
  if (manager.repository.get(INTENSION_NODE_SID).status !== 'active') return false;
  // One task per service, including the parsing node: that *is* the serialization.
  return manager.repository.activeTaskOfService(INTENSION_NODE_SID) === null;
}

/**
 * The goal a parse task runs with: the user's words, verbatim and nothing else.
 *
 * No header, no id, no "you are parsing" line — the goal is *the input*, and an
 * agent that reads only its goal still reads exactly what the user said. What
 * the parser needs beyond the words (which row it holds, the service the user
 * named, the architecture to judge against) it reads from `context()`, which is
 * keyed by the task it is running in. That also keeps the words usable as a
 * prompt: a user who types a tool command is talking to the agent directly.
 */
export function parseGoal(row) {
  return row.content;
}

/**
 * A task reached a terminal status. If it was a parse task, that is also the end
 * of its intension — arranged and answered when the task completed, released
 * back into the queue when it did not. Either way the queue moves afterwards:
 * the parsing node is free now, or a row was waiting behind this very task.
 */
export function afterTaskSettled(manager, task, status) {
  if (task.parent_task_id === null && task.sid === INTENSION_NODE_SID) {
    if (status === 'completed') completedTask(manager, task);
    else releasedFromTask(manager, task);
  }
  drain(manager);
}

/**
 * A finished parse task answers for its intension. This is the normal ending:
 * however the agent ended its task — `task_complete` (tool or `lush task
 * complete`), or simply answering — the result *is* the response, and the tasks
 * it delegated are what it arranged. `arranged` is derived rather than
 * reported: the parse task's own children are its arrangement.
 *
 * A parser that settled the row itself first (and said nothing then) gets its
 * closing answer recorded here: filled in, never overwritten.
 */
export function completedTask(manager, task) {
  const row = manager.repository.openIntensionOfTask(task.id);
  if (row === null) return fillSilentResponse(manager, task);
  const arranged = arrangedIds(manager, row);
  const result = task.result ?? null;
  const said = typeof result === 'string' ? result.trim() !== '' : result !== null;
  if (arranged.length === 0 && !said) {
    // Neither arranged nor said anything: that is not an answer, it is an
    // unfinished parse. Back to the queue (`attempts` bounds the retry).
    return releasedFromTask(manager, task);
  }
  return close(manager, row.id, {
    status: 'settled',
    resolution: { kind: 'arranged', task_ids: arranged },
    response: typeof result === 'string' ? result : null,
  });
}

/** The row the parser settled early with nothing to say: the closing answer is it. */
function fillSilentResponse(manager, task) {
  const result = task.result;
  if (typeof result !== 'string' || result.trim() === '') return null;
  const row = manager.repository.silentIntensionOfTask(task.id);
  if (row === null) return null;
  return manager.repository.recordIntensionResponse(row.id, result);
}

/**
 * A human ran the parse in their own terminal and reported the outcome
 * (`intent submit --interactive`). That is a verdict, not an agent's silence: the
 * row is closed as it stands even when nothing was said — the "unfinished parse"
 * heuristic below would otherwise put the input back in the queue and parse it
 * again behind the human's back.
 */
export function handedOver(manager, taskId, output = null) {
  const row = manager.repository.openIntensionOfTask(taskId);
  if (row === null) return null;
  const said = typeof output === 'string' && output.trim() !== '' ? output : null;
  return close(manager, row.id, {
    status: 'settled',
    resolution: { kind: 'arranged', task_ids: arrangedIds(manager, row) },
    response: said,
  });
}

/**
 * The parse task is gone without settling: the row goes back to the queue, or
 * is rejected once the parser has burned its attempts. Called for every way a
 * parse task can end that is not a clean completion, which is what makes an
 * agent that never settles cost the user a retry instead of their input.
 */
export function releasedFromTask(manager, task) {
  const row = manager.repository.openIntensionOfTask(task.id);
  if (row === null) return null;
  if (row.attempts >= MAX_ATTEMPTS) {
    return close(manager, row.id, {
      status: 'rejected',
      resolution: {
        kind: 'exhausted', attempts: row.attempts, task_id: task.id, error: task.error ?? null,
      },
      response: null,
    });
  }
  return manager.repository.requeueIntension(row.id, {
    resolution: {
      kind: 'requeue', attempts: row.attempts, task_id: task.id, error: task.error ?? null,
    },
  });
}

/** The tasks one row's parser arranged — its own children, whoever it was. */
function arrangedIds(manager, row) {
  if (row.parse_task_id === null || row.parse_task_id === undefined) return [];
  const task = manager.repository.findTask(row.parse_task_id);
  if (task === null) return [];
  return manager.repository.childTasks(task.id).map((child) => child.id);
}

// ── The parser's verbs ─────────────────────────────────────────────────────

/**
 * Close the row the parser is holding: `settled` when it was arranged (or
 * answered), `rejected` when the parser refuses it. A closed row is final, and
 * its waiters are released.
 */
export function settle(manager, { intensionId = null, fromTaskId = null, status, response = null, reason = null }) {
  const row = resolve(manager, { intensionId, fromTaskId });
  if (isClosed(row)) {
    throw new LushError(`intension ${row.id} is ${row.status}; it is already settled`, -32010);
  }
  if (status !== 'settled' && status !== 'rejected') {
    throw new LushError("status must be 'settled' or 'rejected'", -32602);
  }
  if (response !== null && response !== undefined && (typeof response !== 'string' || response.length > MAX_RESPONSE)) {
    throw new LushError(`response must be a string (max ${MAX_RESPONSE})`, -32602);
  }
  // A blank response is "nothing to say yet", not an empty conclusion: it stays
  // NULL so a later closing answer can fill it in (`completedTask`).
  const said = response === undefined || response === null || response.trim() === '' ? null : response;
  if (reason !== null && reason !== undefined) text(reason, 'reason', MAX_REASON);
  const task_ids = arrangedIds(manager, row);
  const resolution = status === 'rejected'
    ? { kind: 'rejected', reason: reason ?? null, task_ids }
    : { kind: 'arranged', reason: reason ?? null, task_ids };
  return close(manager, row.id, { status, resolution, response: said });
}

/**
 * The conflict answer "let that task finish first": back into the queue, behind
 * `blockedByTaskId`. The parse task is released as a side effect (it no longer
 * holds a row), so it finishes its turn normally and the queue moves on.
 */
export function defer(manager, { intensionId = null, fromTaskId = null, blockedByTaskId, reason = null }) {
  const row = resolve(manager, { intensionId, fromTaskId });
  if (isClosed(row)) {
    throw new LushError(`intension ${row.id} is ${row.status}; it is already settled`, -32010);
  }
  validSid(blockedByTaskId);
  const blocker = manager.repository.getTask(blockedByTaskId); // a missing task reports -32004
  if (blocker.id === row.parse_task_id) {
    throw new LushError(`intension ${row.id} cannot wait behind task ${blocker.id}: that task is parsing it`, -32010);
  }
  if (reason !== null && reason !== undefined) text(reason, 'reason', MAX_REASON);
  return manager.repository.deferIntension(row.id, {
    blockedByTaskId: blocker.id,
    resolution: { kind: 'defer', blocked_by_task_id: blocker.id, reason: reason ?? null },
  });
}

/** The one place a row becomes terminal: every way of closing it goes through here. */
function close(manager, intensionId, detail) {
  const closed = manager.repository.settleIntension(intensionId, detail);
  // Closing the row is also the parser letting go: it owes the user nothing
  // more, so the work it arranged is no longer its business (see `handoff`).
  if (closed.parse_task_id !== null && closed.parse_task_id !== undefined) {
    handoff(manager, closed.parse_task_id);
  }
  wake(manager, intensionId);
  return closed;
}

/**
 * The handoff: a parse task that has concluded its intension gives up the subtree
 * it arranged, and the promoted tasks become roots of their own.
 *
 * This is what makes "a parser settles as soon as it has arranged the work" true
 * rather than aspirational. A parse task's children are the work it created, and
 * the task layer will not let a terminal task keep active children
 * (`core/tasks/rules.js`) — so without this the parse task would park in
 * `waiting` and hold the parsing node (and with it the whole input queue,
 * `canParse`) for as long as its arrangement runs. Handing off first means it can
 * finish on the spot and the next input is parsed while the work that came out of
 * this one keeps going.
 *
 * Only the concluded hand off: while the parser still holds an open row, that row
 * *and* the tasks it delegated are both its business (`completedTask` reads the
 * children to derive `resolution.task_ids`). The parser therefore has to settle
 * before it ends its turn — which is exactly the protocol its prompt states.
 *
 * Returns the promoted task ids, or null when nothing was handed off.
 */
export function handoff(manager, taskId) {
  const task = manager.repository.findTask(taskId);
  // Only a root task on the parsing node is a parser (`afterTaskSettled` reads
  // the same shape), and only a busy one has anything to hand over.
  if (task === null || task.parent_task_id !== null || task.sid !== INTENSION_NODE_SID) return null;
  if (manager.repository.openIntensionOfTask(taskId) !== null) return null;
  const promoted = manager.repository.detachChildTasks(taskId);
  if (promoted.length === 0) return null;
  // A parked parser is parked on exactly these children: it has nothing left to
  // wait for, so wake its runtime and let it finish this turn. (Mid-invocation
  // this is a no-op: nobody is parked on the task at that moment.)
  manager.resumeTask(taskId);
  return promoted;
}

/** The conflict notice a parse task just posted belongs to the row it holds. */
export function attachNotice(manager, notice) {
  if (notice.task_id === null || notice.task_id === undefined) return null;
  const row = manager.repository.openIntensionOfTask(notice.task_id);
  if (row === null) return null;
  manager.repository.linkNoticeToIntension(notice.id, row.id);
  // A `wait` notice parks the reporter, so it parks the row with it: the queue
  // is now visibly waiting on the user. A pure record changes nothing.
  if (notice.wait) manager.repository.parkIntensionAwaiting(row.id);
  return row.id;
}

/** The parse task is running again (its conflict notice was settled): so is the row. */
export function resumeFromTask(manager, taskId) {
  const row = manager.repository.openIntensionOfTask(taskId);
  if (row === null || row.status !== 'awaiting') return null;
  return manager.repository.resumeIntensionParsing(row.id);
}

// ── Reads ──────────────────────────────────────────────────────────────────

/**
 * `intent.list`: the queue and its history, newest first. `status` narrows to
 * one status, `open` to the whole queue, and the two "absent" target values ask
 * different questions: `sid` omitted means *any*, `sid: null` means *the user
 * named none*.
 */
export function list(manager, { status = null, sid = undefined, open = false, limit = 200 } = {}) {
  if (status !== null && !INTENSION_STATUSES.includes(status)) {
    throw new LushError(`status must be one of ${INTENSION_STATUSES.join(', ')}`, -32602);
  }
  if (sid !== undefined && sid !== null) validSid(sid);
  if (typeof open !== 'boolean') throw new LushError('open must be a boolean', -32602);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new LushError('limit must be an integer in 1..1000', -32602);
  }
  return manager.repository.listIntensions({ status, sid, open, limit });
}

/**
 * `intent.show`: the row, the parse task that is (or was) working on it, and
 * every notice the conflict conversation produced. One call answers "what did
 * the user say, what was made of it, and who is still owed what".
 */
export function inspect(manager, intensionId) {
  const row = requireIntension(manager, intensionId);
  const parseTask = row.parse_task_id === null ? null : manager.repository.findTask(row.parse_task_id);
  return {
    ...row,
    parse_task: parseTask === null ? null : taskSummary(parseTask),
    notices: manager.repository.listNotices({ intensionId: row.id, limit: 100 }),
  };
}

/**
 * The architecture as the parser must see it, derived from the rows themselves
 * (`task.trace` is the same kind of read model): the loaded template tree — the
 * capability boundaries and singletons the loaded code actually declares, not
 * what a service was created with — the service tree with each node's active
 * task, the whole open queue, and what the user is already being asked about.
 *
 * `precheck` is the mechanical half done for the parser: for the target the
 * user named, existence / status / adoption / whether it is busy, plus rows of
 * the same input that are already in the queue. A `precheck` fact is a conflict
 * *candidate*, not a verdict — the parser still decides whether the user has to
 * be asked or the input is simply wrong.
 */
export function context(manager, { intensionId = null, fromTaskId = null } = {}) {
  const row = resolve(manager, { intensionId, fromTaskId });
  const active = new Map(manager.repository.activeTasks().map((task) => [task.sid, task]));
  const services = manager.repository.list();
  return {
    intension: {
      id: row.id, sid: row.sid, content: row.content, source: row.source,
      status: row.status, attempts: row.attempts,
      blocked_by_task_id: row.blocked_by_task_id, resolution: row.resolution,
    },
    precheck: precheck(manager, row, active),
    parser: {
      sid: INTENSION_NODE_SID,
      busy_task: taskFacts(active.get(INTENSION_NODE_SID) ?? null),
      queue: manager.repository.openIntensions()
        .filter((queued) => queued.id !== row.id)
        .map((queued) => ({ id: queued.id, sid: queued.sid, status: queued.status, content: queued.content })),
      open_notices: manager.repository.listNotices({ status: 'open', limit: 100 })
        .map((notice) => ({
          id: notice.id, kind: notice.kind, title: notice.title,
          task_id: notice.task_id, intension_id: notice.intension_id,
        })),
    },
    architecture: {
      templates: templateTree(manager),
      services: services.map((service) => ({
        sid: service.sid,
        name: service.name,
        template: service.template,
        status: service.status,
        parent_sid: service.parent_sid,
        original_parent_sid: service.original_parent_sid,
        orphan: isOrphan(service),
        child_templates: service.template_snapshot?.child_templates ?? [],
        active_task: taskFacts(active.get(service.sid) ?? null),
      })),
    },
  };
}

/** What one busy node is working on, in the shape both halves of `context` use. */
function taskFacts(task) {
  if (task === null) return null;
  return { id: task.id, status: task.status, goal: task.goal };
}

/** `intent.context` addressed by the task that holds the row (the parser's own view). */
export function contextOfTask(manager, taskId) {
  return context(manager, { fromTaskId: taskId });
}

function precheck(manager, row, active) {
  const target = row.sid === null ? null : targetFacts(manager, row.sid, active);
  const duplicates = manager.repository.listIntensions({ open: true, limit: 1000 })
    .filter((queued) => queued.id !== row.id && queued.sid === row.sid && queued.content === row.content)
    .map((queued) => ({ id: queued.id, status: queued.status }));
  return { target, duplicates };
}

function targetFacts(manager, sid, active) {
  if (!manager.repository.exists(sid)) return { sid, exists: false };
  const service = manager.repository.get(sid);
  return {
    sid,
    exists: true,
    name: service.name,
    template: service.template,
    status: service.status,
    parent_sid: service.parent_sid,
    orphan: isOrphan(service),
    is_parser: sid === INTENSION_NODE_SID,
    child_templates: service.template_snapshot?.child_templates ?? [],
    active_task: taskFacts(active.get(sid) ?? null),
  };
}

/** Adopted by SID 0: this node lost the parent it was created under. */
function isOrphan(service) {
  return service.sid > 0 && service.parent_sid === 0 && service.original_parent_sid !== 0;
}

function templateTree(manager) {
  const loaded = manager.templates === null || manager.templates === undefined ? null : manager.templates.templates;
  if (loaded === null || loaded === undefined) return [];
  return Object.values(loaded).map((template) => ({
    name: template.name,
    singleton: template.singleton,
    description: template.description,
    child_templates: template.child_templates,
  }));
}

// ── Waiting ────────────────────────────────────────────────────────────────

/**
 * `intent.wait`: block until the row is closed. In-memory like `task.wait` —
 * the waiter and the row live in the same daemon, and a restarted daemon
 * requeues unfinished rows rather than resuming the wait.
 */
export function waitForIntension(manager, intensionId) {
  const row = requireIntension(manager, intensionId);
  if (isClosed(row)) return Promise.resolve(row);
  return new Promise((resolve) => {
    const waiters = manager.intensionWaiters.get(intensionId) ?? new Set();
    waiters.add(() => resolve(manager.repository.getIntension(intensionId)));
    manager.intensionWaiters.set(intensionId, waiters);
  });
}

/** Fire every waiter parked on a row that just closed. */
function wake(manager, intensionId) {
  const waiters = manager.intensionWaiters.get(intensionId);
  if (waiters === undefined) return;
  manager.intensionWaiters.delete(intensionId);
  for (const resolve of waiters) resolve(intensionId);
}

/** How many intensions still occupy the queue (`system.status`). */
export function openCount(manager) {
  return manager.repository.openIntensionCount();
}
