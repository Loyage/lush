import { check, text } from '../types.js';

/** 两类用户输入：develop 会派生 worker 产码，explain 只出结论、不产生待合并改动。 */
export const FLOWS = new Set(['develop', 'explain']);

/** 输入与流程判定。 */
export default {
  /**
   * 输入落库前的唯一准备：id 先定（只往大走、永不复用，锚点的分支名与目录名跟着它），
   * 再由 Git 边界把「提交这一刻的代码」锚成一条分支加一个检出。
   * 这一步是异步的（要串行走 Git 队列），所以输入提交会短暂等正在进行的 Git 操作。
   */
  async anchorInput(branch = null) {
    const inputId = this.store.nextInputId();
    const anchor = await this.workspaces.anchor(inputId, branch);
    return { inputId, anchor };
  },

  /** 锚点建好之后的落库：inputs 行 + 根 planner + 调用方自己的关联行，全在一个事务里。 */
  insertInput(inputId, anchor, content, attach = null, references = []) {
    return this.store.transaction(() => {
      this.store.run(`INSERT INTO inputs(id,content,anchor_branch,anchor_commit,anchor_workspace,anchor_target_branch)
        VALUES (?,?,?,?,?,?)`, inputId, content, anchor.branch, anchor.commit, anchor.workspace, anchor.target);
      this.store.setInputReferences(inputId, references.map(reference => ({ segment: 1, reference })));
      const task = this.store.create({ input_id: inputId, role: 'planner', goal: content });
      this.store.run('UPDATE inputs SET task_id=? WHERE id=?', task.id, inputId);
      this.store.event(task.id, 'input.anchor', { input_id: inputId, branch: anchor.branch, commit: anchor.commit,
        target_branch: anchor.target, workspace: anchor.workspace, dirty_source: anchor.dirty_source });
      if (attach) attach(task);
      return { id: inputId, content, references, task, anchor };
    });
  },

  /**
   * The single place a root planner is created; input.submit and draft.commit both land here.
   * 锚不住就不接受输入：Git 建锚点失败时 inputs 一条都不写，草稿也留在缓存里等下一次提交。
   */
  async createInput(content, attach = null, branch = null, references = []) {
    text(content, 'input');
    const normalized = this.normalizeReferences(references);
    if (branch !== null && branch !== undefined) text(branch, 'branch');
    const { inputId, anchor } = await this.anchorInput(branch);
    try { return this.insertInput(inputId, anchor, content, attach, normalized); }
    catch (error) {
      // 已经落到磁盘上的锚点要跟着回滚，否则同名的分支与目录会挡住之后可能用到这个 id 的提交。
      await this.workspaces.releaseAnchor(anchor)
        .catch(failure => console.error(`input ${inputId}: anchor cleanup failed: ${failure.message}`));
      throw error;
    }
  },

  async submit(content, branch = null, references = [], direct = false) {
    check(typeof direct === 'boolean', 'direct must be a boolean');
    let worker;
    const result = await this.createInput(content, direct ? planner => {
      this.store.run("UPDATE inputs SET flow='develop' WHERE id=?", planner.input_id);
      const spec = this.addSpec(planner.id, { goal: content, role: 'worker', name: `direct-${planner.input_id}` });
      worker = this.materializeSpec(planner.id, spec.id);
      this.store.update(planner.id, { status: 'completed', result: '用户选择直接执行：未调用规划模型。' });
      this.store.event(planner.id, 'input.direct', { worker: worker.id, spec: spec.id });
      this.store.event(planner.id, 'completed', { result: '用户选择直接执行：未调用规划模型。', direct: true });
    } : null, branch, references);
    if (direct) { result.task = this.store.task(result.task.id); result.worker = worker; result.direct = true; }
    this.kick(); return result;
  },

  /** 意图视图：一条输入 + 它的锚点 + 它的 planner（拆解）与 scheduler（编排）进度，一起喂给界面。 */
  inputs() {
    const rows = this.store.all(`SELECT inputs.id, inputs.flow, substr(inputs.content,1,2000) AS content, inputs.task_id, inputs.created_at,
      inputs.anchor_branch, inputs.anchor_commit, inputs.anchor_workspace, inputs.anchor_target_branch,
      tasks.status, tasks.plan_gate, tasks.agent_wakes, tasks.updated_at AS planner_updated_at,
      EXISTS(SELECT 1 FROM events e WHERE e.task_id=tasks.id AND e.type='input.direct') AS direct,
      (SELECT count(*) FROM drafts WHERE drafts.input_id=inputs.id) AS draft_count,
      (SELECT count(*) FROM task_specs WHERE task_specs.input_id=inputs.id AND task_specs.status='pending') AS specs_pending,
      (SELECT count(*) FROM task_specs WHERE task_specs.input_id=inputs.id AND task_specs.status='planned') AS specs_planned,
      (SELECT count(*) FROM task_specs WHERE task_specs.input_id=inputs.id AND task_specs.status='dropped') AS specs_dropped,
      NULL AS scheduler_id, NULL AS scheduler_status,
      (SELECT n.id FROM notices n WHERE n.task_id=inputs.task_id AND n.status='open' AND n.kind='plan' ORDER BY n.id DESC LIMIT 1) AS plan_notice_id,
      (SELECT count(*) FROM tasks w WHERE w.input_id=inputs.id AND w.layer='work') AS work_tasks,
      (SELECT count(*) FROM tasks w WHERE w.input_id=inputs.id AND w.layer='work' AND w.role NOT IN ('verifier','showcase')
        AND w.status NOT IN ('completed','failed','cancelled')) AS work_active,
      (SELECT count(*) FROM tasks w WHERE w.input_id=inputs.id AND w.role='worker' AND w.status='failed') AS work_failed,
      (SELECT s.id FROM tasks s WHERE s.input_id=inputs.id AND s.role='showcase' ORDER BY s.id DESC LIMIT 1) AS showcase_task_id,
      (SELECT s.status FROM tasks s WHERE s.input_id=inputs.id AND s.role='showcase' ORDER BY s.id DESC LIMIT 1) AS showcase_status,
      (SELECT c.id FROM review_candidates c WHERE c.input_id=inputs.id ORDER BY c.version DESC LIMIT 1) AS candidate_id,
      (SELECT c.version FROM review_candidates c WHERE c.input_id=inputs.id ORDER BY c.version DESC LIMIT 1) AS candidate_version,
      (SELECT c.status FROM review_candidates c WHERE c.input_id=inputs.id ORDER BY c.version DESC LIMIT 1) AS candidate_status,
      (SELECT c.report_task_id FROM review_candidates c WHERE c.input_id=inputs.id ORDER BY c.version DESC LIMIT 1) AS candidate_report_task_id
      FROM inputs JOIN tasks ON tasks.id=inputs.task_id ORDER BY inputs.id DESC LIMIT 100`);
    // 快照只回显引用摘要；完整快照留给 planner invocation，避免历史输入撑大 RPC 帧。
    return rows.map(row => ({ ...row, references: this.store.inputReferences(row.id).map(reference => ({
      segment: reference.segment, kind: reference.kind, target: reference.target, label: reference.label,
      quote: reference.quote.slice(0, 200), captured_at: reference.captured_at,
    })) }));
  },

  /** The root planner decides which flow an input takes; runtime only records it and enforces the explain constraint in spawn(). */
  setInputFlow(taskId, flow) {
    const task = this.store.task(taskId);
    check(FLOWS.has(flow), 'flow must be develop or explain');
    check(task.parent_id === null, 'only a root task can classify an input');
    check(task.role !== 'showcase', 'showcase agents cannot classify inputs');
    check(task.input_id !== null, 'task belongs to no input');
    this.store.transaction(() => {
      this.store.run('UPDATE inputs SET flow=? WHERE id=?', flow, task.input_id);
      this.store.event(task.id, 'input.flow', { input_id: task.input_id, flow });
    });
    return { input_id: task.input_id, task_id: task.id, flow };
  }
};
