import { check } from '../types.js';
import { choiceForkPath, readChoiceFile } from '../../agent/choice-context.js';

/** Historical compatibility only. New questionnaires never capture snapshots or create routes. */
export default {
  recoverChoiceSnapshots() {
    // No late capture from an unrelated, later worktree. No re-execution of an incomplete fork.
    this.store.run("UPDATE choice_snapshots SET status='unavailable',revision=lower(hex(randomblob(16))),pointer=NULL,reason=? WHERE status='pending'",
      '选择快照已停用；未完成的历史快照不会补拍');
    for (const row of this.store.all("SELECT * FROM choice_rechoices WHERE status='creating'")) {
      this.store.run("UPDATE choice_rechoices SET status='unknown',error=? WHERE request_id=?", '后台中断，创建副作用未知', row.request_id);
      if (row.task_id && this.store.get('SELECT id FROM tasks WHERE id=?', row.task_id))
        this.store.update(row.task_id, { status: 'failed', error: '重选创建曾中断；请检查保留的工作区，不自动重放' });
    }
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
