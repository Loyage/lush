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
    this.guide = agentGuide(agentMode);
  }

  build(process, currentCall) {
    const pid = process.pid;
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
      { role: 'system', content: `${context.systemPrompt}\n\n${this.guide}` },
      { role: 'system', content: lushContextMessage(data) },
      ...this.repository.conversation(pid, currentCall),
    ];
    return new BuiltContext({
      context, metadata: summary(metadata), parent, children, messages, guide: this.guide, data,
    });
  }
}
