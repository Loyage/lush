import { BuiltContext, ProcessContext, lushContextMessage } from './context.js';
import { agentGuide } from '../agent/guide.js';

const SUMMARY_KEYS = ['pid', 'parent_pid', 'original_parent_pid', 'name', 'type', 'template', 'status', 'goal', 'created_at'];

export function summary(process) {
  const result = {};
  for (const key of SUMMARY_KEYS) result[key] = process[key];
  return result;
}

export class ContextBuilder {
  /**
   * `agentMode` selects the shared Lush layer: `tools` for Lush's own runtime
   * (process_* tools), `cli` for external agents that drive Lush through the
   * `lush` CLI. The built messages are only used by in-process providers;
   * external backends receive the same system prompt, guide and data directly.
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
   * Build one invocation's context. `agentMode` may be overridden per process:
   * the agent a process selected can be a different backend than the daemon's
   * fallback one, and the shared Lush layer must match the backend that runs it
   * (`cli` for external pi, `tools` for the in-process runtimes).
   */
  build(process, currentCall, agentMode = this.agentMode) {
    const pid = process.pid;
    const guide = this.guideFor(agentMode);
    const metadata = this.repository.get(pid);
    const context = ProcessContext.load(this.repository, pid);
    const parent = metadata.parent_pid === null
      ? null
      : summary(this.repository.get(metadata.parent_pid));
    const children = this.repository.children(pid).map(summary);
    const childTemplates = metadata.template_snapshot.child_templates ?? [];
    let available = [];
    if (this.templates) {
      available = Object.values(this.templates.templates)
        .filter((template) => template.name !== 'lush-root' && (childTemplates.includes('*') || childTemplates.includes(template.name)))
        // "Available" must mean "spawn would succeed": a singleton that already has
        // an active instance under this PID is rejected by spawn, so advertising it
        // only wastes a failed call.
        .filter((template) => !template.singleton || this.repository.activeCount(pid, template.name) === 0)
        .map((template) => ({
          name: template.name,
          type: template.type,
          singleton: template.singleton,
          description: template.description,
          spawn_prompt: template.spawn_prompt,
        }));
    }
    const data = {
      process: summary(metadata),
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
      ...this.repository.conversation(pid, currentCall),
    ];
    return new BuiltContext({
      context, metadata: summary(metadata), parent, children, messages, guide, data,
    });
  }
}
