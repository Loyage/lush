import { LushError } from '../../core/types.js';
import { RUNNER_METHODS, runnerManagement, validateRunnerParams } from '../runner-methods.js';

export const handlers = Object.fromEntries(Object.entries(RUNNER_METHODS).map(([method, spec]) => [method, (project, params) => {
  const { _token, ...value } = params;
  validateRunnerParams(method, value);
  // The registry is also imported by Node-hosted Pi extensions: load Bun Project internals only on execution.
  const perform = async () => {
    try { return method === 'runner.worker.reconcile'
      ? await (await import('../../core/project/runner-tool-reconcile.js')).reconcileRunnerTools(project, value.id, value.expected_revision) : await runnerManagement(project.runners, method, value); }
    catch (error) { throw new LushError(error instanceof LushError ? error.message : 'Runner verification was not confirmed; inspect its current state'); }
  };
  // Participate in the project write/drain gate without keeping a SQLite/Git lock over SSH.
  return spec.readPath ? perform() : project.write('manage Runner settings', perform);
}]));
