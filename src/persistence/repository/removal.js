/**
 * Hard removal: deleting a service's rows for good, audited. Forwards to
 * `repository_removal.js`, which walks the tables and reports what went.
 *
 * Exported as a method group: `index.js` merges it into `Repository`.
 */
import { deleteRows, remove } from '../repository_removal.js';

export const removalMethods = {
  /** Delete every row one sid owns; only called inside `remove`'s transaction. */
  _deleteRows(sid) {
    return deleteRows(this, sid);
  },

  remove(sids, audit = null) {
    return remove(this, sids, audit);
  },
};
