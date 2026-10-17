import { id } from '../types.js';
import { assertLocalWorker } from './execution-retired.js';

/** Task identity is resolved here; legacy remote paths never reach local readers. */
function read(project, taskId, options, method) {
  const task = project.store.task(id(taskId));
  assertLocalWorker(project, task.id);
  return project.workspaces[method](task, options);
}

export default {
  codeState(taskId, options = {}) { return read(this, taskId, options, 'codeState'); },
  codeTree(taskId, options = {}) { return read(this, taskId, options, 'codeTree'); },
  codeFile(taskId, options = {}) { return read(this, taskId, options, 'codeFile'); },
};
