import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { check, id, TERMINAL } from '../types.js';
import { questionnaireAnswer } from '../questionnaire.js';
import { workerLabel } from '../worker-number.js';
import { readCommitPointer } from '../../agent/fork.js';
import { choiceContextPath, choiceForkPath, choiceDigest, readChoiceFile, writeChoiceFile, freezeChoiceContext } from '../../agent/choice-context.js';
import { snapshotPath, saveInputRule } from '../task-input-rule.js';
import { assertTaskAncestorsOpen, assertTaskNotSyncing, resumeTaskDelivery, consumeIntegratedReservation } from './iteration.js';

const LIMITATIONS = [
  '重选另建独立 Worker；原路线不会暂停，原答案与成果保留，已合并代码不会撤回。',
  '只保存本 Worker 文件现场和 Pi/Lush 会话；不保存其他 Worker、进程、外部服务、ignored 内容或暂存区分层。',
  '排除明确的凭证文件名，但不能检测源码或历史记录中任意嵌入的秘密；已有 Git 历史不清洗。',
  '最多 10000 个文件、总计 64 MiB、单文件 8 MiB；已跟踪的排除文件、符号链接、submodule、冲突或不完整会话不可恢复。',
];
const taskResult = (project, taskId) => {
  const task = project.store.task(taskId);
  return { id: task.id, worker_number: task.worker_number, status: task.status, branch: task.branch,
    parent_id: task.parent_id, task_kind: task.task_kind };
};
const rowFor = (project, noticeId) => project.store.get('SELECT * FROM choice_snapshots WHERE notice_id=?', noticeId);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
// Diagnostics are fixed categories, never filesystem contents or raw provider errors.
function snapshotFailure(error) {
  const message = String(error?.message ?? '');
  if (/exceeds|大小上限|bounded regular/.test(message)) return '代码或上下文超过快照大小限制';
  if (/excluded|credential/.test(message)) return '已跟踪文件包含必须排除的凭证或内部内容，无法保存完整快照';
  if (/submodules/.test(message)) return '工作区包含子模块，无法保存完整快照';
  if (/conflict-free/.test(message)) return '暂存区存在未解决冲突，无法保存完整快照';
  if (/links|symlink|special files/.test(message)) return '工作区或上下文包含链接或特殊文件，无法安全快照';
  if (/Pi session|Pi tool|Pi compaction|marker/.test(message)) return 'Pi 上下文边界不完整或格式不受支持';
  return '未能在选择边界保存完整代码与上下文';
}

function parentFor(project, snapshot) {
  project.assertWritable('rechoose a notice');
  check(!project.stopping, '项目后台正在停止');
  const parent = project.store.task(snapshot.parent_id);
  check(['main','owner','order','child'].includes(parent.task_kind) && parent.branch === snapshot.target_branch && !TERMINAL.has(parent.status),
    '原直接父 Worker 已结束或归属已改变，不能重选；不会改投 main');
  // main/legacy bound roots need not have a genealogy row (same admission as assertInputParent).
  const record = project.store.branch(parent.branch);
  check(!record || record.status === 'active', '原父分支已归档或删除，不能重选');
  assertTaskAncestorsOpen(project, parent);
  assertTaskNotSyncing(project, parent.id);
  project.assertBranchWritable(parent.branch, 'create a choice route');
  return parent;
}

function reusable(project, row, noticeId, answer, revision) {
  check(row.notice_id === noticeId && row.answer === answer && row.revision === revision,
    'request_id 已用于不同的选择；请为新的操作使用新的 request_id');
  check(row.status === 'created', row.status === 'creating' ? '重选创建尚在进行，稍后用同一 request_id 重试'
    : '此前重选创建未完成，现场已保留；请检查关联 Worker，不会重放未知操作');
  return { notice_id: noticeId, task: taskResult(project, row.task_id), reused: true };
}

export default {
  /** Called in the original notice transaction, before either human or automatic settlement. */
  prepareChoiceSnapshot(noticeId, task) {
    const run = this.running.get(task.id);
    let reason = null, pointer = null, profile = null, rule = null;
    try {
      check(run?.recordId && ['order','child'].includes(task.task_kind) && task.branch && task.workspace,
        '该问卷没有可固定的开发调用与专属工作区');
      check(run.agent?.agent === 'pi' && run.agent.config_mode !== 'pi', '当前后端或模式不支持完整上下文恢复（仅 Pi/Lush）');
      pointer = readCommitPointer(this.config.home, task.id, run.recordId);
      check(pointer, '没有当前调用的可信 Pi 上下文边界');
      profile = this.agentSettings.retryProfile('agent', run.agent);
      const file = snapshotPath(this.config.home, task.id);
      if (fs.existsSync(file)) {
        rule = readChoiceFile(this.config.home, file).toString('utf8');
        check(Buffer.byteLength(rule) <= 16384, '固定输入规则过大');
      }
    } catch (error) { reason = error.message.startsWith('该问卷') || error.message.startsWith('当前后端') || error.message.startsWith('没有当前')
      ? error.message : '无法固定完整运行配置、上下文或输入规则'; }
    this.store.run(`INSERT INTO choice_snapshots(notice_id,task_id,status,revision,reason,run_id,parent_id,target_branch,
      source_branch,source_workspace,profile,pointer,rule) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, noticeId, task.id,
    reason ? 'unavailable' : 'pending', randomUUID(), reason, run?.recordId ?? null, task.parent_id, task.target_branch,
    task.branch, task.workspace, profile ? JSON.stringify(profile) : null, pointer ? JSON.stringify(pointer) : null, rule);
    if (!reason) run.choiceNoticeId = noticeId;
  },

  /** The running ownership is retained until this finishes: no subsequent invocation or child landing can pass it. */
  async finishChoiceSnapshot(taskId, run) {
    if (!run.choiceNoticeId) return;
    const snapshot = rowFor(this, run.choiceNoticeId);
    if (!snapshot || snapshot.status !== 'pending') return;
    const guard = () => {
      check(!this.stopping && this.running.get(taskId) === run && run.parked && run.invocationEnded,
        '选择快照没有完整的实际退出边界');
      const task = this.store.task(taskId), current = rowFor(this, snapshot.notice_id);
      check(current?.status === 'pending' && current.revision === snapshot.revision && task.branch === snapshot.source_branch
        && task.workspace === snapshot.source_workspace && !TERMINAL.has(task.status), '选择现场身份已改变');
    };
    try {
      guard();
      const bytes = freezeChoiceContext(this.config.home, taskId, JSON.parse(snapshot.pointer));
      const captured = await this.workspaces.captureChoiceSnapshot(this.store.task(taskId), snapshot.notice_id, guard);
      // Retain the commit even if saving context fails so deletion can account for every published ref.
      this.store.run('UPDATE choice_snapshots SET commit_hash=? WHERE notice_id=?', captured.commit, snapshot.notice_id);
      guard();
      writeChoiceFile(this.config.home, choiceContextPath(this.config.home, snapshot.notice_id), bytes);
      this.store.transaction(() => {
        this.store.run("UPDATE choice_snapshots SET status='ready',revision=?,context_digest=?,pointer=NULL,reason=NULL WHERE notice_id=?",
          randomUUID(), choiceDigest(bytes), snapshot.notice_id);
        this.store.event(taskId, 'notice.snapshot_ready', { notice_id: snapshot.notice_id, commit: captured.commit });
      });
    } catch (error) {
      this.store.transaction(() => {
        this.store.run("UPDATE choice_snapshots SET status='unavailable',revision=?,pointer=NULL,reason=? WHERE notice_id=?",
          randomUUID(), `${snapshotFailure(error)}；原流程继续，此选择点不可重选`, snapshot.notice_id);
        this.store.event(taskId, 'notice.snapshot_unavailable', { notice_id: snapshot.notice_id });
      });
    }
  },

  recoverChoiceSnapshots() {
    // No late capture from an unrelated, later worktree. No re-execution of an incomplete fork.
    this.store.run("UPDATE choice_snapshots SET status='unavailable',revision=lower(hex(randomblob(16))),pointer=NULL,reason=? WHERE status='pending'",
      '项目后台在快照完成前中断；不会把后来的现场冒充选择点');
    for (const row of this.store.all("SELECT * FROM choice_rechoices WHERE status='creating'")) {
      this.store.run("UPDATE choice_rechoices SET status='unknown',error=? WHERE request_id=?", '后台中断，创建副作用未知', row.request_id);
      if (row.task_id && this.store.get('SELECT id FROM tasks WHERE id=?', row.task_id))
        this.store.update(row.task_id, { status: 'failed', error: '重选创建曾中断；请检查保留的工作区，不自动重放' });
    }
  },

  async noticeSnapshot(noticeId) {
    const notice = this.store.get('SELECT * FROM notices WHERE id=?', id(noticeId));
    check(notice, 'notice not found');
    const snapshot = rowFor(this, notice.id), source = this.store.task(notice.task_id);
    const result = { notice_id: notice.id, status: snapshot?.status ?? 'unavailable', revision: snapshot?.revision ?? `legacy-${notice.id}`,
      reason: snapshot?.reason ?? (snapshot ? null : '此记录没有选择快照；历史记录不补拍'), created_at: snapshot?.created_at ?? null,
      source_task_id: source.id, source_worker_number: source.worker_number ?? null,
      commit: snapshot?.commit_hash ?? null, context_mode: snapshot?.profile ? 'pi-lush' : null,
      can_rechoose: false, blockers: [], limitations: LIMITATIONS };
    if (result.status !== 'ready') { result.blockers.push(result.reason ?? '快照正在等待调用实际退出并保存'); return result; }
    if (notice.kind !== 'questionnaire' || !['answered','dismissed'].includes(notice.status)) result.blockers.push('只有已回答或已忽略的结构化问卷可重选');
    try { parentFor(this, snapshot); } catch (error) { result.blockers.push(error.message); }
    try {
      readChoiceFile(this.config.home, choiceContextPath(this.config.home, notice.id), snapshot.context_digest);
      const commit = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/lush/choice-snapshots/${notice.id}^{commit}`);
      check(commit === snapshot.commit_hash, 'snapshot changed');
    } catch { result.blockers.push('快照代码或上下文资源缺失、损坏或已改变'); }
    try { await this.workspaces.git(this.config.project, 'show-ref', '--verify', `refs/heads/${snapshot.target_branch}`); }
    catch { result.blockers.push('原父分支已不存在'); }
    result.can_rechoose = result.blockers.length === 0;
    return result;
  },

  rechooseNotice(noticeId, answer, revision, requestId) {
    return this.write('rechoose a notice', () => this.workspaces.exclusive(async () => {
      const notice = this.store.get('SELECT * FROM notices WHERE id=?', id(noticeId));
      check(notice?.kind === 'questionnaire' && ['answered','dismissed'].includes(notice.status), 'only settled questionnaires can be reselected');
      check(uuid(requestId), 'request_id must be a UUID');
      check(typeof revision === 'string' && revision.length > 0 && revision.length <= 128, 'invalid snapshot revision');
      const normalized = questionnaireAnswer(notice.body, answer), storedAnswer = JSON.stringify(normalized);
      const receipt = this.store.get('SELECT * FROM choice_rechoices WHERE request_id=?', requestId);
      if (receipt) return reusable(this, receipt, notice.id, storedAnswer, revision);
      const snapshot = rowFor(this, notice.id);
      check(snapshot?.status === 'ready' && snapshot.revision === revision, 'snapshot is not ready or revision changed; refresh it');
      const view = await this.noticeSnapshot(notice.id);
      check(view.can_rechoose, view.blockers.join('; '));
      const guard = () => {
        const current = rowFor(this, notice.id);
        check(current?.status === 'ready' && current.revision === revision, 'snapshot changed');
        return parentFor(this, snapshot);
      };
      const parent = guard(), source = this.store.task(notice.task_id);
      const profile = this.agentSettings.retryProfile('agent', JSON.parse(snapshot.profile));
      check(profile.agent === 'pi' && profile.config_mode !== 'pi', 'snapshot requires Pi/Lush context');
      const bytes = readChoiceFile(this.config.home, choiceContextPath(this.config.home, notice.id), snapshot.context_digest);
      const inputId = this.store.nextInputId();
      const goal = `${source.goal}\n\n从历史问卷 #${notice.id} 的选择快照另开路线，按本轮 choice_reselection 中用户的新答案继续。原路线保留，不回滚已合并成果。`;
      // A durable paused identity/receipt precedes asynchronous Git. A crash is inspectable, never duplicated.
      const task = this.store.transaction(() => {
        guard();
        this.store.run('INSERT INTO inputs(id,content) VALUES (?,?)', inputId, goal);
        const created = this.store.create({ parent_id: parent.id, input_id: inputId, role: 'agent', goal,
          name: `choice-${notice.id}-${inputId}`, task_kind: 'order' });
        this.store.update(created.id, { status: 'paused', retry_profile: JSON.stringify(profile),
          auto_merge: JSON.stringify({ version: 1, enabled: false, locked: false }) });
        this.store.run('UPDATE inputs SET task_id=? WHERE id=?', created.id, inputId);
        this.store.run(`INSERT INTO choice_rechoices(request_id,notice_id,revision,answer,status,task_id,context_digest)
          VALUES (?,?,?,?,'creating',?,?)`, requestId, notice.id, revision, storedAnswer, created.id, snapshot.context_digest);
        return this.store.task(created.id);
      });
      try {
        await this.workspaces.forkTaskUnsafe(task, parent.branch, snapshot.commit_hash);
        guard();
        check(this.store.task(task.id).status === 'paused' && !this.running.has(task.id), 'new route was changed during creation');
        writeChoiceFile(this.config.home, choiceForkPath(this.config.home, task.id), bytes);
        if (snapshot.rule !== null) saveInputRule(this.config.home, task.id, snapshot.rule);
        this.store.transaction(() => {
          const liveParent = guard();
          resumeTaskDelivery(this, liveParent.id, 'new choice route');
          if (liveParent.status === 'awaiting_acceptance') {
            consumeIntegratedReservation(this, liveParent, 'new choice route');
            this.store.update(liveParent.id, { status: 'waiting' });
          }
          const created = this.store.task(task.id);
          check(created.status === 'paused' && !this.running.has(created.id), 'new route was changed during creation');
          this.store.run('UPDATE inputs SET anchor_branch=?,anchor_commit=?,anchor_workspace=?,anchor_target_branch=? WHERE id=?',
            created.branch, snapshot.commit_hash, created.workspace, parent.branch, inputId);
          this.store.run("UPDATE choice_rechoices SET status='created' WHERE request_id=?", requestId);
          this.store.update(created.id, { status: 'queued' });
          this.store.event(created.id, 'notice.reselected', { notice_id: notice.id, source_task_id: source.id,
            request_id: requestId, commit: snapshot.commit_hash });
          this.store.event(source.id, 'notice.choice_route_created', { notice_id: notice.id, task_id: created.id });
        });
        this.kick();
        return { notice_id: notice.id, task: taskResult(this, task.id), reused: false };
      } catch {
        this.store.run("UPDATE choice_rechoices SET status='unknown',error=? WHERE request_id=?", '创建未完成，保留现场供检查', requestId);
        if (!TERMINAL.has(this.store.task(task.id).status)) this.store.update(task.id,
          { status: 'failed', error: '重选创建未完成；工作区和历史已保留，不自动重放' });
        throw new Error(`重选创建未完成，已保留 Worker ${workerLabel(task)} 供检查；不会重复创建`);
      }
    }));
  },

  choiceRouteCreating(taskId) {
    return Boolean(this.store.get("SELECT request_id FROM choice_rechoices WHERE task_id=? AND status='creating'", taskId));
  },

  /** An independent private copy survives archival of the original route. */
  choiceFork(taskId, agent) {
    const row = this.store.get('SELECT * FROM choice_rechoices WHERE task_id=?', taskId);
    if (!row) return null;
    check(row.status === 'created', '重选创建尚未完成或副作用未知；不能启动不完整路线');
    // Every invocation rechecks identity; PiProvider decides whether an existing own session is resumed.
    check(agent.agent === 'pi' && agent.config_mode !== 'pi', '该重选路线需要 Pi/Lush 模式恢复上下文，不能静默改为空会话');
    const file = choiceForkPath(this.config.home, taskId);
    readChoiceFile(this.config.home, file, row.context_digest);
    return { file, digest: row.context_digest };
  },

  choiceReselectionContext(taskId) {
    const row = this.store.get("SELECT r.notice_id,r.answer,n.title,n.body,n.task_id AS source_task_id FROM choice_rechoices r JOIN notices n ON n.id=r.notice_id WHERE r.task_id=? AND r.status='created'", taskId);
    return row ? { notice_id: row.notice_id, source_task_id: row.source_task_id, title: row.title,
      questionnaire: JSON.parse(row.body), answer: JSON.parse(row.answer), answer_source: 'user',
      instruction: '这是从选择前快照创建的独立路线。使用这里的新答案，不读取或采用原路线此后的答案与成果；历史会话中的 Worker 身份和子 Worker 只作资料，不能把它们当成本 Worker 或本 Worker 的后代。仅在当前专属工作区继续；不撤回父分支已合并成果。' } : null;
  },
};
