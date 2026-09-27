import { text } from '../types.js';
import { matchInputRoute } from '../input-routes.js';

/** 输入。 */
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
  createInput(content, attach = null, branch = null, references = []) {
    return this.write('submit an input', () => this.submitInput(content, attach, branch, references));
  },

  async submitInput(content, attach = null, branch = null, references = []) {
    text(content, 'input');
    // 冻结中的分支不接受新的 intent：一键合并 / 解冲突期间在目标分支及其子树上建新输入会扰动合并。
    let effectiveBranch = branch;
    if (effectiveBranch === null || effectiveBranch === undefined) {
      try { effectiveBranch = await this.workspaces.git(this.config.project, 'symbolic-ref', '--short', 'HEAD'); }
      catch { effectiveBranch = null; }
    }
    if (effectiveBranch) this.assertBranchWritable(effectiveBranch, 'create a new intent on it');
    const normalized = this.normalizeReferences(references);
    if (branch !== null && branch !== undefined) text(branch, 'branch');
    const { inputId, anchor } = await this.anchorInput(branch);
    try {
      // Git was asynchronous: a clear may have started while the anchor was being created.
      this.assertWritable('submit an input');
      return this.insertInput(inputId, anchor, content, attach, normalized);
    }
    catch (error) {
      // 已经落到磁盘上的锚点要跟着回滚，否则同名的分支与目录会挡住之后可能用到这个 id 的提交。
      await this.workspaces.releaseAnchor(anchor)
        .catch(failure => console.error(`input ${inputId}: anchor cleanup failed: ${failure.message}`));
      throw error;
    }
  },

  /**
   * 输入的唯一提交路径：命中快速路由前缀就直接派活，未命中就交给规划模型。
   * 命中前缀时同一次事务里走 routeInput，未命中时 planner 保持 queued 等被调度。
   */
  async submit(content, branch = null, references = []) {
    const match = matchInputRoute(this.config.inputRoutes, content);
    let worker = null;
    const result = await this.createInput(content, planner => {
      if (match) worker = this.routeInput(planner, match);
    }, branch, references);
    if (match) {
      result.task = this.store.task(result.task.id);
      result.route = { prefix: match.prefix, target: match.target };
      if (match.target === 'worker') result.worker = worker; else result.research = worker;
    }
    this.kick(); return result;
  },

  /**
   * 快速路由前缀的短路动作：不调用规划模型，直接把 planner 结算为 completed，
   * 并按前缀目标（worker / research）在同一事务里创建一条根任务。
   * 保留 input.anchor / 原始输入 / 引用 / 输入分支，并写一条 input.route 事件可追溯。
   */
  routeInput(planner, match) {
    const spec = this.addSpec(planner.id, { goal: match.content, role: match.target, name: `${match.target}-${planner.input_id}` });
    const task = this.materializeSpec(planner.id, spec.id);
    const result = `前缀 ${match.prefix} 命中：未调用规划模型，直接创建 ${match.target} #${task.id}`;
    this.store.update(planner.id, { status: 'completed', result });
    this.store.event(planner.id, 'input.route', { input_id: planner.input_id, prefix: match.prefix, target: match.target,
      task: task.id, spec: spec.id });
    this.store.event(planner.id, 'completed', { result, route: true, prefix: match.prefix, target: match.target,
      task: task.id, spec: spec.id });
    return task;
  },

  /** 意图视图：一条输入 + 它的锚点 + 它的 planner（拆解）与 scheduler（编排）进度，一起喂给界面。 */
  inputs() {
    const rows = this.store.all(`SELECT inputs.id, substr(inputs.content,1,2000) AS content, inputs.task_id, inputs.created_at,
      inputs.anchor_branch, inputs.anchor_commit, inputs.anchor_workspace, inputs.anchor_target_branch,
      tasks.status, tasks.plan_gate, tasks.agent_wakes, tasks.updated_at AS planner_updated_at,
      EXISTS(SELECT 1 FROM events e WHERE e.task_id=tasks.id AND e.type='input.route') AS route,
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
};
