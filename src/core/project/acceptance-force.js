import { createHash } from 'node:crypto';
import { check, TERMINAL } from '../types.js';
import { assertLocalWorker } from './execution-retired.js';

// Only settled informational receipts, never requests, repair instructions or unknown signal kinds.
const RECEIPTS = new Set(['child.completed', 'child.failed', 'child.cancelled', 'merge.completed']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const messageIdentity = message => ({ id: message.id, task_id: message.task_id, sender_id: message.sender_id,
  body: message.body, consumed: message.consumed, signal_type: message.signal_type, signal_key: message.signal_key,
  delivery_hold: message.delivery_hold, append_number: message.append_number });

function skippable(project, task, message) {
  if (!TERMINAL.has(task.status) || message.delivery_hold !== null || message.append_number !== null
    || !RECEIPTS.has(message.signal_type) || !message.signal_key || message.sender_id === null) return false;
  const source = project.store.get('SELECT id,parent_id FROM tasks WHERE id=?', message.sender_id);
  if (source?.parent_id !== task.id) return false;
  let envelope;
  try { envelope = JSON.parse(message.body); } catch { return false; }
  if (envelope?.version !== 1 || envelope.signal !== message.signal_type || envelope.key !== message.signal_key
    || envelope.source_task_id !== message.sender_id || envelope.target_task_id !== task.id) return false;
  // Typed columns/body alone are not provenance. Require the exact runtime event in the same inbox.
  return Boolean(project.store.get(`SELECT id FROM events WHERE task_id=? AND type='task.signal'
    AND json_valid(data) AND json_extract(data,'$.message_id')=? AND json_extract(data,'$.source_task_id')=?
    AND json_extract(data,'$.signal')=? AND json_extract(data,'$.key')=? LIMIT 1`, task.id, message.id,
  message.sender_id, message.signal_type, message.signal_key));
}

/** Read-only, bounded confirmation scope. Never consumes or rewrites historical messages. */
export function forceAcceptanceScope(project, task, subtree) {
  check(subtree.length <= 200, '强制验收范围过大；请先处理较小的子树');
  const rows = [], skipped = [], notifications = [];
  let count = 0;
  for (const row of subtree) {
    assertLocalWorker(project, row.id);
    const messages = project.store.all('SELECT * FROM messages WHERE task_id=? AND consumed=0 ORDER BY id LIMIT 501', row.id);
    count += messages.length;
    check(count <= 500, '强制验收未读消息过多；请先处理收件箱');
    const identity = { id: row.id, worker_number: row.worker_number, parent_id: row.parent_id, task_kind: row.task_kind,
      status: row.status, branch: row.branch, workspace: row.workspace, target_branch: row.target_branch,
      head_commit: row.head_commit, reservation: row.reservation };
    rows.push({ ...identity, messages: messages.map(messageIdentity),
      decisions: project.store.all("SELECT id,status FROM notices WHERE task_id=? AND status='open' ORDER BY id", row.id),
      execution_retired: project.store.executionRetired(row.id) });
    for (const message of messages) if (skippable(project, row, message)) {
      skipped.push(messageIdentity(message));
      const source = project.store.task(message.sender_id);
      notifications.push({ message_id: message.id, worker_id: row.id, worker_number: row.worker_number,
        status: row.status, signal_type: message.signal_type, sender_worker_number: source.worker_number,
        sender_id: source.id });
    }
  }
  const branches = project.store.branches().filter(branch => subtree.some(row => row.branch === branch.branch));
  const revision = hash({ id: task.id, rows, branches, skipped });
  const preview = { id: task.id, revision, can_force: true,
    workers: rows.map(({ messages, decisions, execution_retired, reservation, ...row }) => row), notifications,
    resources: { worktrees: rows.map(row => row.workspace).filter(Boolean), branches: branches.map(row => row.branch) },
    warnings: ['仅跳过所列终态 Worker 的系统通知，不表示 Agent 已处理。原消息和跳过审计保留。',
      '验收将归档回收分支子树的 worktree 与本地 ref；失败/取消后代保留原状态，不调用 Agent。',
      '用户追加、普通消息、暂存输入、待决、脏现场、未交付改动、在途执行和远端未知状态仍阻止验收。'] };
  check(Buffer.byteLength(JSON.stringify(preview)) < 192000, '强制验收预检过大；请缩小范围');
  return { preview, skipped };
}

/** Recheck exact confirmed receipts at every resource boundary; newly arrived input always blocks. */
export function assertForceAcceptanceMessages(project, skipped) {
  for (const fixed of skipped) {
    const current = project.store.get('SELECT * FROM messages WHERE id=?', fixed.id);
    check(current && JSON.stringify(messageIdentity(current)) === JSON.stringify(fixed)
      && skippable(project, project.store.task(fixed.task_id), current), '强制验收通知已变化；请重新预检并确认');
  }
}
