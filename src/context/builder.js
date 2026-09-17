import { BuiltContext, ProcessContext } from './context.js';
import { jsonDump } from '../core/types.js';

const SUMMARY_KEYS = ['pid', 'parent_pid', 'original_parent_pid', 'name', 'type', 'template', 'status', 'goal', 'created_at'];

export function summary(process) {
  const result = {};
  for (const key of SUMMARY_KEYS) result[key] = process[key];
  return result;
}

export class ContextBuilder {
  constructor(repository, templates = null) {
    this.repository = repository;
    this.templates = templates;
  }

  build(process, currentCall) {
    const pid = process.pid;
    const metadata = this.repository.get(pid);
    const context = ProcessContext.load(this.repository, pid);
    const parent = metadata.parent_pid === null
      ? null
      : summary(this.repository.get(metadata.parent_pid));
    const children = this.repository.children(pid).map(summary);
    const allowed = metadata.template_snapshot.allowed_child_templates;
    let available = [];
    if (this.templates) {
      available = Object.values(this.templates.templates)
        .filter((template) => template.name !== 'lush-root' && (allowed.includes('*') || allowed.includes(template.name)))
        .map((template) => ({
          name: template.name,
          process_type: template.process_type,
          description: template.description,
        }));
    }
    const data = {
      process: summary(metadata),
      parent,
      children,
      state: context.state,
      artifacts: context.artifacts,
      references: context.references,
      allowed_child_templates: allowed,
      available_child_templates: available,
    };
    const messages = [
      {
        role: 'system',
        content: `${context.systemPrompt}\nUse the provided process tools, not shell commands. `
          + 'Context below is current runtime data. Do not invent tool results. '
          + 'A reply does not complete a task; call process_complete only when its goal is met.',
      },
      { role: 'system', content: `LUSH_CONTEXT\n${jsonDump(data)}` },
      ...this.repository.conversation(pid, currentCall),
    ];
    return new BuiltContext({ context, metadata: summary(metadata), parent, children, messages });
  }
}
