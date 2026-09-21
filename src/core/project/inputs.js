import { check, text } from '../types.js';

/** 两类用户输入：develop 会派生 worker 产码，explain 只出结论、不产生待合并改动。 */
export const FLOWS = new Set(['develop', 'explain']);

/** 输入与流程判定。 */
export default {
  /** The single place a root planner is created; input.submit and draft.commit both land here. */
  createInput(content, references = []) {
    text(content, 'input');
    const normalized = this.normalizeReferences(references);
    return this.store.transaction(() => {
      const row = this.store.run('INSERT INTO inputs(content) VALUES (?)', content);
      const inputId = Number(row.lastInsertRowid);
      this.store.setInputReferences(inputId, normalized.map(reference => ({ segment: 1, reference })));
      const task = this.store.create({ input_id: inputId, role: 'planner', goal: content });
      this.store.run('UPDATE inputs SET task_id=? WHERE id=?', task.id, inputId);
      return { id: inputId, content, references: normalized, task };
    });
  },

  submit(content, references = []) {
    const result = this.createInput(content, references);
    this.kick(); return result;
  },

  /** 意图视图：一条输入 + 它的 planner（拆解）与 scheduler（编排）进度，一起喂给界面。 */
  inputs() {
    const rows = this.store.all(`SELECT inputs.id, inputs.flow, substr(inputs.content,1,2000) AS content, inputs.task_id, inputs.created_at,
      tasks.status, tasks.plan_gate, tasks.agent_wakes, tasks.updated_at AS planner_updated_at,
      (SELECT count(*) FROM drafts WHERE drafts.input_id=inputs.id) AS draft_count,
      (SELECT count(*) FROM task_specs WHERE task_specs.input_id=inputs.id AND task_specs.status='pending') AS specs_pending,
      (SELECT count(*) FROM task_specs WHERE task_specs.input_id=inputs.id AND task_specs.status='planned') AS specs_planned,
      (SELECT count(*) FROM task_specs WHERE task_specs.input_id=inputs.id AND task_specs.status='dropped') AS specs_dropped,
      (SELECT s.batch_id FROM task_specs s WHERE s.input_id=inputs.id AND s.batch_id IS NOT NULL ORDER BY s.id DESC LIMIT 1) AS scheduler_id,
      (SELECT t.status FROM task_specs s JOIN tasks t ON t.id=s.batch_id WHERE s.input_id=inputs.id AND s.batch_id IS NOT NULL
        ORDER BY s.id DESC LIMIT 1) AS scheduler_status,
      (SELECT n.id FROM notices n WHERE n.task_id=inputs.task_id AND n.status='open' AND n.kind='plan' ORDER BY n.id DESC LIMIT 1) AS plan_notice_id,
      (SELECT count(*) FROM tasks w WHERE w.input_id=inputs.id AND w.layer='work') AS work_tasks
      FROM inputs JOIN tasks ON tasks.id=inputs.task_id ORDER BY inputs.id DESC LIMIT 100`);
    // 快照只需要回显引用摘要；完整快照留在库里，planner invocation 直接读取，避免 100 条历史输入把 RPC 帧撑爆。
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
    check(task.input_id !== null, 'task belongs to no input');
    this.store.transaction(() => {
      this.store.run('UPDATE inputs SET flow=? WHERE id=?', flow, task.input_id);
      this.store.event(task.id, 'input.flow', { input_id: task.input_id, flow });
    });
    return { input_id: task.input_id, task_id: task.id, flow };
  }
};
