// Compatibility export for callers that still expect one built-in prompt.
// Runtime invocations use agentPrompt(config, role, profile) from prompts.js.
import { builtInPrompt } from './prompts.js';

export const GUIDE = builtInPrompt('planner');
