import { check, id } from '../types.js';
import { tokenHash } from './internal.js';
import { managementState } from './management-data.js';

export function assertManager(project, actorId) {
  const task = project.store.task(id(actorId)), state = managementState(task), run = project.running.get(task.id);
  check(task.role === 'manager' && task.task_kind === 'management' && state?.version === 1,
    'only a management Worker can use management tools');
  check(task.status === 'running' && run && !run.parked && !run.invocationEnded && !run.controller.signal.aborted
    && typeof run.token === 'string' && task.agent_token_hash === tokenHash(run.token), 'management invocation is not active');
  check(state.enabled && state.state === 'running' && state.pending_signal?.phase === 'started'
    && state.pending_signal.run_id === run.recordId, 'management binding or signal authorization is not active');
  return { task, state };
}
