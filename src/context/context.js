/** Context is a first-class resource, independent of provider message formats. */
export class ProcessContext {
  constructor({ system_prompt, state, artifacts, references, message_count }) {
    this.systemPrompt = system_prompt;
    this.state = state;
    this.artifacts = artifacts;
    this.references = references;
    this.messageCount = message_count;
  }

  static load(repository, pid) {
    return new ProcessContext(repository.context(pid));
  }
}

export class BuiltContext {
  constructor({ context, metadata, parent, children, messages }) {
    this.context = context;
    this.metadata = metadata;
    this.parent = parent;
    this.children = children;
    this.messages = messages;
  }
}
