/**
 * Hard removal: deleting a process's rows for good, audited. Forwards to
 * `repository_removal.js`, which walks the tables and reports what went.
 *
 * Exported as a method group: `index.js` merges it into `Repository`.
 */
import { deleteRows, remove } from '../repository_removal.js';

export const removalMethods = {
  /** Delete every row one pid owns; only called inside `remove`'s transaction. */
  _deleteRows(pid) {
    return deleteRows(this, pid);
  },

  remove(pids, audit = null) {
    return remove(this, pids, audit);
  },
};
