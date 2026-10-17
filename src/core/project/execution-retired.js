import { check } from '../types.js';

export const RETIRED_EXECUTION = 'Remote execution is retired; this Worker is read-only';

/** A legacy binding must never turn into a local filesystem or Git operation. */
export function assertLocalWorker(project, workerId) {
  check(!project.store.executionRetired(workerId), RETIRED_EXECUTION);
  return null;
}

export async function inspectLocalSafePoint(project, workerId, { guard = () => {} } = {}) {
  assertLocalWorker(project, workerId);
  return { guard };
}
