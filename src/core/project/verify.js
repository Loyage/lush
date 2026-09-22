import fs from 'node:fs';
import path from 'node:path';
import { check, isPlainObject } from '../types.js';

const EVIDENCE_STATUSES = new Set(['pass','fail','partial','unverified']);
const EVIDENCE_LISTS = ['failures','unverified','baseline_failures','residual_risks'];

function evidenceText(value, name, limit = 32000) {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= limit,
    `${name} must be non-empty text (max ${limit} characters)`);
  return value;
}
function evidenceList(value, name) {
  check(Array.isArray(value) && value.length <= 100, `${name} must be an array (max 100 items)`);
  return value.map((item, index) => evidenceText(item, `${name}[${index}]`, 4000));
}
function evidenceExit(value, name) {
  check(Number.isInteger(value) && value >= -1 && value <= 65535,
    `${name} must be an integer between -1 and 65535`);
  return value;
}

/** 检验任务、结构化证据与报告位置。 */
export default {
  /** 自包含 HTML 检验报告：由 verifier 自己写文件，runtime 只决定它在哪。 */
  reportPath(taskId) {
    const role = this.store.get('SELECT role FROM tasks WHERE id=?', taskId)?.role;
    return path.join(this.config.home, role === 'showcase' ? 'showcase' : 'verify', String(taskId), 'report.html');
  },

  /** 与报告同目录的机器可读证据；runtime 校验后复制进 versioned run.result Artifact。 */
  evidencePath(taskId) { return path.join(this.config.home, 'verify', String(taskId), 'evidence.json'); },

  hasReport(taskId) { return fs.existsSync(this.reportPath(taskId)); },

  /**
   * Read and strictly validate evidence supplied by a verifier. Commit bindings and report references are
   * runtime facts, never trusted from the agent-owned file. A normal invocation without evidence is explicitly
   * unverified; malformed evidence fails the invocation rather than being relabelled as success.
   * @param {object} task
   * @returns {{status: 'pass'|'fail'|'partial'|'unverified', tested_commit: string|null, baseline_commit: string|null}}
   */
  verificationEvidence(task) {
    const context = this.verificationContext(task);
    const evidenceFile = this.evidencePath(task.id);
    const report = { task_id: task.id, path: this.reportPath(task.id), available: this.hasReport(task.id) };
    const testedCommit = task.review_candidate_id ? context.candidate.commit : context.head_commit;
    const base = { tested_commit: testedCommit ?? null, baseline_commit: context.baseline_commit ?? null, report };
    if (!fs.existsSync(evidenceFile)) return { status: 'unverified', ...base, commands: [],
      summary: 'The verifier completed without structured verification evidence.', failures: [],
      unverified: ['No evidence.json was produced.'], baseline_failures: [], residual_risks: [] };
    const stat = fs.statSync(evidenceFile);
    check(stat.isFile() && stat.size <= 131072, 'verification evidence must be a file no larger than 131072 bytes');
    let value;
    try { value = JSON.parse(fs.readFileSync(evidenceFile, 'utf8')); }
    catch { check(false, 'verification evidence must be valid JSON'); }
    check(isPlainObject(value) && value.schema_version === 1, 'verification evidence schema_version must be 1');
    check(EVIDENCE_STATUSES.has(value.status), 'verification evidence status must be pass, fail, partial or unverified');
    const commands = value.commands;
    check(Array.isArray(commands) && commands.length <= 100, 'verification evidence commands must be an array (max 100 items)');
    const normalizedCommands = commands.map((command, index) => {
      check(isPlainObject(command), `verification evidence commands[${index}] must be an object`);
      const normalized = { command: evidenceText(command.command, `commands[${index}].command`, 4000),
        exit_code: evidenceExit(command.exit_code, `commands[${index}].exit_code`),
        baseline_exit_code: command.baseline_exit_code === null || command.baseline_exit_code === undefined ? null
          : evidenceExit(command.baseline_exit_code, `commands[${index}].baseline_exit_code`),
        summary: evidenceText(command.summary, `commands[${index}].summary`, 4000) };
      return normalized;
    });
    const normalized = { status: value.status, ...base, commands: normalizedCommands,
      summary: evidenceText(value.summary, 'verification evidence summary'),
      ...Object.fromEntries(EVIDENCE_LISTS.map(field => [field, evidenceList(value[field], `verification evidence ${field}`)])) };
    if (normalized.status !== 'unverified') check(normalized.commands.length > 0,
      `${normalized.status} verification evidence must include at least one command`);
    if (normalized.status === 'pass') {
      check(normalized.commands.every(command => command.exit_code === 0),
        'pass verification evidence cannot contain a failing tested exit code');
      check(normalized.failures.length === 0,
        'pass verification evidence cannot contain failures');
      check(normalized.unverified.length === 0,
        'pass verification evidence cannot contain unverified items');
      // baseline_failures and residual_risks describe the comparison baseline and acknowledged
      // remaining risk; they do not contradict a pass for the tested candidate assertions.
    }
    if (normalized.status === 'fail') check(normalized.failures.length > 0,
      'fail verification evidence must describe at least one failure');
    if (normalized.status === 'partial') check(normalized.failures.length + normalized.unverified.length + normalized.residual_risks.length > 0,
      'partial verification evidence must describe incomplete coverage or risk');
    if (normalized.status === 'unverified') check(normalized.unverified.length > 0,
      'unverified evidence must describe what was not verified');
    return normalized;
  },

  /** Latest structured conclusion for a verification task; old/missing artifacts stay unknown. */
  verificationResult(taskId) {
    const artifact = this.store.artifactsForTask(taskId).filter(row => row.kind === 'run.result').at(-1);
    return artifact?.payload?.verification ?? { status: 'unknown', tested_commit: null, baseline_commit: null,
      commands: [], summary: 'No structured verification evidence is available.', report: null,
      failures: [], unverified: [], baseline_failures: [], residual_risks: [] };
  },

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

  /** verifier 的上下文：它要演示哪次改动、对照在哪个目录、报告和结构化证据写到哪。 */
  verificationContext(task) {
    if (task.review_candidate_id) return this.candidateContext(task);
    const target = this.store.task(task.verifies_task_id);
    return {
      verified_task: { id: target.id, goal: target.goal, name: target.name, status: target.status, result: target.result },
      branch: target.branch, base_commit: target.base_commit, head_commit: target.head_commit,
      target_branch: target.target_branch, workspace: target.workspace,
      baseline_workspace: task.baseline_workspace, baseline_commit: task.baseline_commit,
      report_path: this.reportPath(task.id), evidence_path: this.evidencePath(task.id),
    };
  }
};
