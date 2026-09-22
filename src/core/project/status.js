import { bounded } from '../types.js';
import { agentView } from './internal.js';

/** 项目级读模型：任务分布、layers、意图、spec、drafts、agents、待合并、合并冻结、notice 计数。 */
export default {
  status() {
    const alive = this.store.get("SELECT count(*) AS count FROM tasks WHERE status NOT IN ('completed','failed','cancelled')").count;
    const agent_config = this.agentConfig();
    return { project: this.config.project, home: this.config.home,
      provider: this.config.provider === 'mock' ? 'mock' : agent_config.default.agent, agent_config,
      concurrency: this.config.concurrency, control_concurrency: this.config.controlConcurrency,
      // 并发上限是可在运行时改写的项目级设置：这里给出存储 / 生效值的只读镜像。
      // 顶层 concurrency / control_concurrency 仍表示当前生效值。
      settings: this.runtimeSettings(),
      // 软件配置的只读镜像：除并发上限可在运行时改写外，其余在 daemon 启动时从环境变量读一次。
      // pi 的两项覆写未设置时是空字符串，交给界面显示「pi 默认」，不在这里编造 pi 自己的默认模型 / provider。
      call_timeout: this.config.timeout, task_call_limit: this.config.maxCalls, max_depth: this.config.maxDepth,
      pi_model: this.config.env.LUSH_PI_MODEL || '', pi_provider: this.config.env.LUSH_PI_PROVIDER || '',
      // Work execution and intent planning use separate admission lanes.
      tasks: this.store.all("SELECT status, count(*) AS count FROM tasks WHERE layer='work' GROUP BY status"),
      layers: this.store.all('SELECT layer, status, count(*) AS count FROM tasks GROUP BY layer, status'),
      intents: { total: this.store.get('SELECT count(*) AS count FROM inputs').count,
        waiting_approval: this.store.get("SELECT count(*) AS count FROM tasks WHERE role='planner' AND plan_gate='proposed'").count },
      specs: { ...this.store.specStats(), batches: [], compiler: 'deterministic' },
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
