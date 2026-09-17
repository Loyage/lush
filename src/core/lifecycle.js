import { LushError } from './types.js';

export const ACTIVE = new Set(['created', 'running']);
export const TASK_TERMINAL = new Set(['completed', 'failed', 'cancelled', 'reclaimed']);

const TRANSITIONS = {
  service: {
    created: new Set(['running', 'stopped', 'failed']),
    running: new Set(['stopped', 'failed']),
    stopped: new Set(['running']),
    failed: new Set(['running']),
  },
  task: {
    created: new Set(['running', 'cancelled', 'failed']),
    running: new Set(['completed', 'failed', 'cancelled']),
    completed: new Set(['reclaimed']),
    failed: new Set(['reclaimed']),
    cancelled: new Set(['reclaimed']),
    reclaimed: new Set(),
  },
};

export function validateTransition(process, target) {
  const allowed = TRANSITIONS[process.type][process.status] ?? new Set();
  if (!allowed.has(target)) {
    throw new LushError(`cannot transition ${process.type} ${process.pid} from ${process.status} to ${target}`);
  }
}
