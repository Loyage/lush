// Dependency-free vocabulary shared by CLI schemas and runtime settings.
// Keeping data here avoids loading Prompt composition while building a catalogue.
export const PROMPT_SUPPLEMENT_TARGETS = Object.freeze(['common', 'agent', 'planner', 'coordinator', 'worker', 'research', 'verifier', 'merger', 'explainer', 'butler', 'manager']);
export const AGENT_ROLES = Object.freeze(PROMPT_SUPPLEMENT_TARGETS.slice(1));
export const AGENT_BACKENDS = ['pi', 'codex'];
export const THINKING_LEVELS = {
  pi: ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['', 'minimal', 'low', 'medium', 'high', 'xhigh'],
};
