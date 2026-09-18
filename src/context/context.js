/** Context is a first-class resource, independent of provider message formats. */
import { jsonDump } from '../core/types.js';

/** Prefix of the runtime-context system message; every backend must agree on it. */
export const LUSH_CONTEXT_PREFIX = 'LUSH_CONTEXT\n';

/** Serialize the built runtime data as the shared LUSH_CONTEXT message. */
export function lushContextMessage(data) {
  return `${LUSH_CONTEXT_PREFIX}${jsonDump(data)}`;
}

export class ServiceContext {
  constructor({ system_prompt, state, artifacts, references, message_count }) {
    this.systemPrompt = system_prompt;
    this.state = state;
    this.artifacts = artifacts;
    this.references = references;
    this.messageCount = message_count;
  }

  static load(repository, sid) {
    return new ServiceContext(repository.context(sid));
  }
}

export class BuiltContext {
  constructor({ context, metadata, parent, children, messages, guide, data }) {
    this.context = context;
    this.metadata = metadata;
    this.parent = parent;
    this.children = children;
    this.messages = messages;
    /** Shared Lush layer, also handed to external agent backends. */
    this.guide = guide;
    /** The runtime data payload (LUSH_CONTEXT content) as an object. */
    this.data = data;
  }
}
