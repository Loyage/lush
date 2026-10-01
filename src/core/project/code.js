import { id } from '../types.js';

/** Task identity is resolved here; callers cannot choose a filesystem root or Git ref. */
export default {
  codeState(taskId, options = {}) { return this.workspaces.codeState(this.store.task(id(taskId)), options); },
  codeTree(taskId, options = {}) { return this.workspaces.codeTree(this.store.task(id(taskId)), options); },
  codeFile(taskId, options = {}) { return this.workspaces.codeFile(this.store.task(id(taskId)), options); },
};
