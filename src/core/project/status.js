import { bounded } from '../types.js';
import { agentView } from './internal.js';

/** 项目级读模型：任务分布、layers、意图、spec、drafts、agents、待合并、合并冻结、notice 计数。 */
export default {
  status() {
    const alive = this.store.get("SELECT count(*) AS count FROM tasks WHERE status NOT IN ('completed','failed','cancelled')").count;
    return { project: this.config.project, home: this.config.home, provider: this.config.provider,
      concurrency: this.config.concurrency,
      // 任务链只算 work 层；planner/scheduler 的进度在意图视图里报（layer 单独给计数）。
      tasks: this.store.all("SELECT status, count(*) AS count FROM tasks WHERE layer='work' GROUP BY status"),
      layers: this.store.all('SELECT layer, status, count(*) AS count FROM tasks GROUP BY layer, status'),
      intents: { total: this.store.get('SELECT count(*) AS count FROM inputs').count,
        waiting_approval: this.store.get("SELECT count(*) AS count FROM tasks WHERE role='planner' AND plan_gate='proposed'").count },
      specs: { ...this.store.specStats(),
        batches: bounded(this.store.all("SELECT t.id, t.status, t.role, (SELECT count(*) FROM task_specs s WHERE s.batch_id=t.id) AS count FROM tasks t WHERE t.role='scheduler' ORDER BY t.id DESC LIMIT 100"), 100000) },
      drafts: this.store.draftCount(),
      agents: [...this.running].map(([task_id, run]) => agentView(this.store.task(task_id), run)),
      agents_total: alive, agents_idle: alive - this.running.size,
      // 以原 worker 为稳定交付项；resolver 是它的来源，不在这里重复计数（完整阶段见 task.ladder.groups）。
      pending_merges: this.store.all("SELECT id, substr(goal,1,500) AS goal, branch, integration FROM tasks WHERE resolves_task_id IS NULL AND integration IN ('pending','review','conflict') ORDER BY id LIMIT 100"),
      // 未解决的冲突冻结同一目标分支上的合并：界面据此禁用按钮并说清原因。
      // resolves_task_id 取真正在服务这条冲突的解冲突任务（他不在 W 自己的列上，而是它指向 W）。
      merge_freeze: this.store.all(`SELECT id AS task_id, target_branch,
        (SELECT r.id FROM tasks r WHERE r.resolves_task_id = tasks.id AND r.status NOT IN ('failed','cancelled')
          ORDER BY r.id DESC LIMIT 1) AS resolves_task_id
        FROM tasks WHERE integration='conflict' ORDER BY id LIMIT 50`),
      // 计划审批（kind='plan'）不是「等你回答的问题」，它归意图面板，不在这里计数。
      notices: this.store.get("SELECT count(*) AS count FROM notices WHERE status='open' AND kind IN ('question','questionnaire')").count };
  }
};
