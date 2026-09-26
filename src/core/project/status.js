import { createHash } from 'node:crypto';
import { agentView } from './internal.js';
import { branchFreezeList } from '../branch-freeze.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** Shared status projection. Its task aggregates are served by covering indexes, never task rows. */
function statusView(project, agentConfig = null, introConfig = null) {
  const layers = project.store.all('SELECT layer,status,count FROM overview_task_counts WHERE count>0 ORDER BY layer,status');
  const tasks = layers.filter(row => row.layer === 'work').map(({ status, count }) => ({ status, count }));
  const alive = layers.filter(row => !TERMINAL.has(row.status)).reduce((sum, row) => sum + row.count, 0);
  return { project: project.config.project, home: project.config.home,
    revision: project.overviewRevision(),
    provider: project.config.provider === 'mock' ? 'mock' : (agentConfig?.default?.agent ?? project.config.provider),
    ...(agentConfig ? { agent_config: agentConfig } : {}),
    ...(introConfig ? { intro_config: introConfig } : {}),
    concurrency: project.config.concurrency, control_concurrency: project.config.controlConcurrency,
    // 并发上限是可在运行时改写的项目级设置：这里给出存储 / 生效值的只读镜像。
    // 顶层 concurrency / control_concurrency 仍表示当前生效值。
    settings: project.runtimeSettings(),
    sleep: project.sleepStatus(),
    // 软件配置的只读镜像：并发与调用 / 拆解限额都可在运行时改写；顶层仍是当前生效值，
    // 来源（环境默认 / 是否被覆盖 / 设置文件）在 settings 里。
    // pi 的两项覆写未设置时是空字符串，交给界面显示「pi 默认」，不在这里编造 pi 自己的默认模型 / provider。
    call_timeout: project.config.timeout, task_call_limit: project.config.maxCalls, max_depth: project.config.maxDepth,
    pi_model: project.config.env.LUSH_PI_MODEL || '', pi_provider: project.config.env.LUSH_PI_PROVIDER || '',
    tasks, layers,
    intents: { total: project.store.get('SELECT count(*) AS count FROM inputs').count,
      waiting_approval: project.store.get("SELECT count(*) AS count FROM tasks WHERE role='planner' AND plan_gate='proposed'").count },
    specs: { ...project.store.specStats(), batches: [], compiler: 'deterministic' },
    drafts: project.store.draftCount(),
    agents: [...project.running].map(([task_id, run]) => agentView(project.store.task(task_id), run)),
    agents_total: alive, agents_idle: alive - project.running.size,
    // 以原 worker 为稳定交付项；resolver 是它的来源，不在这里重复计数（完整阶段见 task.ladder.groups）。
    pending_merges: project.store.all("SELECT id, substr(goal,1,500) AS goal, branch, integration FROM tasks WHERE resolves_task_id IS NULL AND integration IN ('pending','review','conflict') ORDER BY id LIMIT 100"),
    // 未解决的冲突冻结同一目标分支上的合并：界面据此禁用按钮并说清原因。
    merge_freeze: project.store.all(`SELECT id AS task_id, target_branch,
      (SELECT r.id FROM tasks r WHERE r.resolves_task_id = tasks.id AND r.status NOT IN ('failed','cancelled')
        ORDER BY r.id DESC LIMIT 1) AS resolves_task_id
      FROM tasks WHERE integration='conflict' ORDER BY id LIMIT 50`),
    // 分支写冻结（一键合并 + 未结束的 merger）与进行中的一键合并运行：只读投影，界面据此禁用写按钮。
    branch_freeze: branchFreezeList(project.store),
    merge_runs: project.store.activeBranchMergeRuns().map(({ target, run }) => ({ target_branch: target, ...run })),
    notices: project.store.get("SELECT count(*) AS count FROM notices WHERE status='open' AND kind IN ('question','questionnaire')").count };
}

/** 项目级读模型：任务分布、layers、意图、spec、drafts、agents、待合并、合并冻结、notice 计数。 */
export default {
  /** Persistent invalidation cursor plus bounded runtime-only facts; no historical table aggregate. */
  overviewRevision() {
    const cursor = this.store.get("SELECT value FROM meta WHERE key='overview_revision'")?.value ?? '0';
    const facts = [cursor, [...this.running.keys()].sort((a, b) => a - b),
      this.config.concurrency, this.config.controlConcurrency, this.sleepStatus()];
    return createHash('sha256').update(JSON.stringify(facts)).digest('base64url').slice(0, 22);
  },

  /** Homepage summary deliberately never opens the complete Agent profile. */
  summary() { return statusView(this); },

  /** Compatibility status retains its complete historical Agent configuration shape. */
  status(includeAgentConfig = true) {
    // 完整状态投影带上 Agent 与快速介绍配置；概览 summary() 不带，设置页按需单独取。
    return statusView(this, includeAgentConfig ? this.agentConfig() : null, includeAgentConfig ? this.introConfig() : null);
  }
};
