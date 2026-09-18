import { BuiltContext, ServiceContext, lushContextMessage } from './context.js';
import { agentGuide } from '../agent/guide.js';
import { availableTemplates } from '../core/queries.js';

const SUMMARY_KEYS = ['sid', 'parent_sid', 'original_parent_sid', 'name', 'template', 'status', 'goal', 'created_at'];

export function summary(service) {
  const result = {};
  for (const key of SUMMARY_KEYS) result[key] = service[key];
  return result;
}

/** The work an agent is currently doing, as the agent itself sees it. */
function taskSummary(task) {
  if (task === null) return null;
  return {
    id: task.id,
    sid: task.sid,
    parent_task_id: task.parent_task_id,
    root_task_id: task.root_task_id,
    status: task.status,
    goal: task.goal,
    result: task.result ?? null,
    error: task.error ?? null,
    state: task.state ?? {},
    created_at: task.created_at,
    finished_at: task.finished_at ?? null,
  };
}

export class ContextBuilder {
  /**
   * `agentMode` selects the shared Lush layer: `tools` for Lush's own runtime
   * (task_* / service_* tools), `cli` for external agents that drive Lush
   * through the `lush` CLI. The built messages are only used by in-service
   * providers; external backends receive the same system prompt, guide and data
   * directly.
   */
  constructor(repository, templates = null, { agentMode = 'tools' } = {}) {
    this.repository = repository;
    this.templates = templates;
    this.agentMode = agentMode;
    this.guides = new Map([[agentMode, agentGuide(agentMode)]]);
  }

  /** The shared Lush layer for one mode; the two modes are cached per builder. */
  guideFor(agentMode) {
    if (!this.guides.has(agentMode)) this.guides.set(agentMode, agentGuide(agentMode));
    return this.guides.get(agentMode);
  }

  /**
   * Build one invocation's context for a task. The service supplies identity,
   * variables, permissions and its tree position; the task supplies the work
   * being done and its own scratch state. `agentMode` may be overridden per
   * task: the agent a service selected can be a different backend than the
   * daemon's fallback one, and the shared Lush layer must match that backend
   * (`cli` for external pi, `tools` for the in-service runtimes).
   */
  build(task, currentCall, agentMode = this.agentMode, { service = null } = {}) {
    const metadata = service ?? this.repository.get(task.sid);
    const sid = metadata.sid;
    const guide = this.guideFor(agentMode);
    const context = ServiceContext.load(this.repository, sid);
    const parent = metadata.parent_sid === null
      ? null
      : summary(this.repository.get(metadata.parent_sid));
    const children = this.repository.children(sid).map(summary);
    const childTemplates = metadata.template_snapshot.child_templates ?? [];
    // One function with `service.view`'s `templates` section: the agent and any
    // parent inspecting this node must see the same "what can it create" list.
    const available = availableTemplates(
      this.templates, childTemplates, (name) => this.repository.activeCount(sid, name),
    );
    const data = {
      service: summary(metadata),
      task: taskSummary(task),
      parent,
      children,
      state: context.state,
      artifacts: context.artifacts,
      references: context.references,
      child_templates: childTemplates,
      available_child_templates: available,
    };
    const messages = [
      { role: 'system', content: `${context.systemPrompt}\n\n${guide}` },
      { role: 'system', content: lushContextMessage(data) },
      ...this.repository.conversation(task.id, currentCall),
    ];
    return new BuiltContext({
      context, metadata: summary(metadata), parent, children, messages, guide, data,
    });
  }

  /**
   * The same view for a task that does not exist yet (the interactive handover): the
   * service, an empty task slot, and no conversation.
   */
  preview(service, goal, agentMode = this.agentMode) {
    return this.build(
      { id: null, sid: service.sid, goal, status: 'created', parent_task_id: null, root_task_id: null },
      null,
      agentMode,
      { service },
    );
  }
}
