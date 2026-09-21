import fs from 'node:fs';
import path from 'node:path';
import { check } from '../types.js';

/** 检验任务与报告位置。 */
export default {
  /** 自包含 HTML 检验报告：由 verifier 自己写文件，runtime 只决定它在哪。 */
  reportPath(taskId) { return path.join(this.config.home, 'verify', String(taskId), 'report.html'); },

  hasReport(taskId) { return fs.existsSync(this.reportPath(taskId)); },

  /**
   * 用户点「检验」：为一个已完成的 worker 派一个只读 verifier，
   * 由它自己判断最直观的演示方式，并对照目标分支的同一场景。
   * 终态任务不能有活动子任务，所以 verifier 是独立根任务，用 verifies_task_id 关联而非 parent_id。
   */
  verify(taskId) {
    const target = this.store.task(taskId);
    check(target.role === 'worker', `only a worker task can be verified; #${target.id} is a ${target.role}`);
    check(target.status === 'completed', `only a completed task can be verified; #${target.id} is ${target.status}`);
    check(target.workspace && fs.existsSync(target.workspace) && target.head_commit,
      `task #${target.id} has no worktree or commit to verify`);
    check(target.target_branch, `task #${target.id} has no target branch to compare against`);
    const active = this.store.activeVerification(target.id);
    check(!active, `verification #${active?.id} is still running; wait for it or cancel it`);
    const goal = `检验 #${target.id}：用最直观的方式演示它这一步改动的实际运行结果，并对照 ${target.target_branch} 分支在当前同样场景下的表现。`;
    const task = this.store.transaction(() => this.store.create({
      parent_id: null, input_id: target.input_id, role: 'verifier', goal,
      name: `verify-${target.id}`, verifies_task_id: target.id }));
    this.store.event(target.id, 'verify.requested', { verify_task: task.id, baseline: target.target_branch });
    // 让界面知道被检验任务刚刚有了新状态，否则轮询不会重新渲染它的详情。
    this.store.touch(target.id);
    this.kick();
    return task;
  },

  /** verifier 的上下文：它要演示哪次改动、对照在哪个目录、报告写到哪。 */
  verificationContext(task) {
    if (task.review_candidate_id) return this.candidateContext(task);
    const target = this.store.task(task.verifies_task_id);
    return {
      verified_task: { id: target.id, goal: target.goal, name: target.name, status: target.status, result: target.result },
      branch: target.branch, base_commit: target.base_commit, head_commit: target.head_commit,
      target_branch: target.target_branch, workspace: target.workspace,
      baseline_workspace: task.baseline_workspace, baseline_commit: task.baseline_commit,
      report_path: this.reportPath(task.id),
    };
  }
};
