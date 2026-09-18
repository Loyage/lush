/**
 * The task inbox: how a task and its direct parent / children talk, how input
 * reaches an agent, and how a settled notice comes home.
 *
 * The model is deliberately asynchronous. A message is **queued**, never
 * interrupt: `send` only inserts a row and wakes a *parked* task. A task that is
 * in the middle of an agent invocation keeps working; the runtime hands it the
 * queued input between two invocations (`take`), which is also how a settling
 * child reports to its parent (`notifyChildSettled`) and how a notice the user
 * settled returns to its reporter (`notifyNoticeSettled`) — one queue, three
 * kinds of input.
 *
 * Waiting lives on the **task**, not inside the agent: the runtime parks a task
 * in `waiting` (children still working) or `awaiting` (a notice still open) and
 * `ServiceManager.waitForTaskInput` resolves when anything lands in its inbox.
 * `task_wait` no longer exists as an agent tool.
 *
 * Every function operates on the `ServiceManager` passed in; `core/tasks/rules.js`
 * and the runtime are the callers.
 */
import { LushError, jsonDump, text, validSid } from '../types.js';
import { isTerminal, requireTask } from './internal.js';

const MAX_BODY = 20_000;

/**
 * Send a message to a direct parent or direct child task. The edge rule mirrors
 * delegation: the task tree is the only address space, so messages cannot form
 * a cycle and a wandering task cannot be reached.
 */
export function send(manager, fromTaskId, toTaskId, body) {
  validSid(fromTaskId);
  validSid(toTaskId);
  const from = requireTask(manager, fromTaskId);
  const to = requireTask(manager, toTaskId);
  if (fromTaskId === toTaskId) {
    throw new LushError(`task ${fromTaskId} cannot message itself`, -32010);
  }
  if (to.parent_task_id !== fromTaskId && from.parent_task_id !== toTaskId) {
    throw new LushError(
      `task ${toTaskId} is not a direct parent or child of task ${fromTaskId}; `
      + 'a task may only message its direct parent or its direct child tasks',
      -32010,
    );
  }
  if (isTerminal(to)) {
    throw new LushError(`task ${toTaskId} is ${to.status}; it can no longer receive messages`, -32010);
  }
  text(body, 'body', MAX_BODY);
  return deliver(manager, { toTaskId, fromTaskId, kind: 'message', body, data: {} });
}

/**
 * The report that a child settled. Called from the task layer's terminal
 * transition, so a parent that is parked wakes up with its child's outcome the
 * same way it wakes up with a message.
 */
export function notifyChildSettled(manager, child) {
  const parentId = child.parent_task_id;
  if (parentId === null || parentId === undefined) return null;
  const parent = manager.repository.findTask(parentId);
  if (parent === null || isTerminal(parent)) return null;
  return deliver(manager, {
    toTaskId: parentId,
    fromTaskId: child.id,
    kind: 'child_settled',
    body: '',
    data: {
      task_id: child.id,
      sid: child.sid,
      status: child.status,
      result: child.result ?? null,
      error: child.error ?? null,
    },
  });
}

/**
 * The report that a notice a task reported was settled by the user. This is the
 * notice's reply channel: opening a `wait` notice binds the answer to the
 * reporter, so `notice.answer` / `notice.dismiss` hand it back here and a parked
 * task wakes with it the way it wakes with a child's result. A notice with no
 * reporter left (a deleted task, or one that already settled) is only a record;
 * nothing is delivered.
 */
export function notifyNoticeSettled(manager, notice) {
  if (!notice.wait || notice.task_id === null || notice.task_id === undefined) return null;
  const task = manager.repository.findTask(notice.task_id);
  if (task === null || isTerminal(task)) return null;
  return deliver(manager, {
    toTaskId: notice.task_id,
    fromTaskId: null,
    kind: 'notice_settled',
    body: '',
    data: {
      notice_id: notice.id,
      kind: notice.kind,
      title: notice.title,
      status: notice.status,
      answer: notice.answer ?? null,
      note: notice.note ?? null,
    },
  });
}

/** How one inbox kind is named in the receiver's event stream. */
const EVENT_KIND = {
  message: 'message_received',
  child_settled: 'child_reported',
  notice_settled: 'notice_settled',
};

function deliver(manager, { toTaskId, fromTaskId, kind, body, data }) {
  const row = manager.repository.createTaskMessage({ toTaskId, fromTaskId, kind, body, data });
  manager.repository.taskEvent(toTaskId, EVENT_KIND[kind] ?? kind, {
    inbox_id: row.id,
    ...(fromTaskId === null || fromTaskId === undefined ? {} : { from_task_id: fromTaskId }),
    ...(kind === 'child_settled' ? { task_id: data.task_id, status: data.status } : {}),
    ...(kind === 'notice_settled' ? { notice_id: data.notice_id, status: data.status } : {}),
  });
  // A parked task must wake up; a running one will pick the row up after its
  // current invocation (the runtime drains the inbox before deciding anything).
  manager.resumeTask(toTaskId);
  return row;
}

/** Undelivered input, marked delivered: what the next invocation is told. */
export function take(manager, taskId) {
  const rows = manager.repository.undeliveredTaskMessages(taskId);
  if (rows.length > 0) manager.repository.deliverTaskMessages(rows.map((row) => row.id));
  return rows;
}

export function pending(manager, taskId) {
  return manager.repository.countUndeliveredTaskMessages(taskId);
}

/** The mailbox of one task, oldest first (read model). */
export function inbox(manager, taskId, { after = 0, limit = 50 } = {}) {
  requireTask(manager, taskId);
  if (!Number.isInteger(after) || after < 0) throw new LushError('after must be a non-negative integer', -32602);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new LushError('limit must be an integer in 1..1000', -32602);
  }
  return manager.repository.listTaskMessages(taskId, { after, limit });
}

/** How the sender of one inbox row is named to the agent. */
function senderLabel(manager, fromTaskId) {
  if (fromTaskId === null || fromTaskId === undefined) return 'Lush';
  const task = manager.repository.findTask(fromTaskId);
  if (task === null) return `task #${fromTaskId}`;
  const service = manager.repository.get(task.sid);
  return `task #${fromTaskId} on ${service.name}[${service.sid}]`;
}

function outcomeText(data) {
  if (data.status !== 'completed') return `${data.status}: ${data.error ?? '(no error recorded)'}`;
  if (data.result === null || data.result === undefined) return 'completed (no result)';
  return typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
}

/** One settled notice, as the reporter's next prompt reads it. */
function noticeText(data) {
  const head = `你上报的 notice #${data.notice_id}（${data.kind}：${data.title}）`;
  if (data.status === 'answered') return `${head} 已由用户答复：${jsonDump(data.answer)}`;
  return `${head} 被用户忽略${data.note ? `：${data.note}` : '（未填答案）'}`;
}

/**
 * The next invocation's prompt, built from the input that arrived: one
 * `role: user` message (persisted by `beginCall`), the same shape every other
 * wake-up uses. The `[Lush]` prefix is what tells an agent this came from the
 * operating system rather than the user.
 */
export function inputPrompt(manager, rows) {
  const lines = rows.map((row) => {
    if (row.kind === 'child_settled') {
      return `- 你的子 task #${row.data.task_id} 已结束 → ${outcomeText(row.data)}`;
    }
    if (row.kind === 'notice_settled') return `- ${noticeText(row.data)}`;
    return `- ${senderLabel(manager, row.from_task_id)} 发来消息：${row.body}`;
  });
  return '[Lush] 你有新的输入：\n'
    + `${lines.join('\n')}\n`
    + '请据此继续：取用 / 汇总这些输入，或再派新的子 task；'
    + '确认目标达成后用 task_complete 结束本 task。';
}
