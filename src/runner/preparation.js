import fs from 'node:fs';
import path from 'node:path';
import { check, hash, stable, workspaceKey } from './protocol.js';

const keys = ['project_id', 'node_id', 'runner_id', 'worker_id', 'workspace_id', 'generation'];
function stat(file) {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function proof(ctx, closing = false) {
  const { store, identity } = ctx, key = workspaceKey(identity), seal = store.preparationClosure(identity);
  if (seal) check(seal.workspace_key === key, 'STALE', 'Preparation closure belongs to a different identity');
  check(!store.db.query('SELECT 1 FROM workspaces WHERE project_id=? AND (worker_id=? OR workspace_id=?) LIMIT 1')
    .get(identity.project_id, identity.worker_id, identity.workspace_id), 'CONFLICT', 'Runner workspace has a registration');
  // Ignore only the original close request, never a register/tool request or another close attempt.
  const own = seal?.request_id ?? (closing ? ctx.request_id : '');
  check(!store.db.query(`SELECT 1 FROM requests WHERE project_id=? AND (workspace_key=?
    OR json_extract(identity_json,'$.worker_id')=? OR json_extract(identity_json,'$.workspace_id')=?)
    AND request_id!=? LIMIT 1`).get(identity.project_id, key, identity.worker_id, identity.workspace_id, own),
  'CONFLICT', 'Runner workspace has recorded preparation or operations');
  for (const table of ['leases', 'executions', 'artifacts', 'command_resources'])
    check(!store.db.query(`SELECT 1 FROM ${table} WHERE workspace_key=? LIMIT 1`).get(key),
      'CONFLICT', 'Runner workspace has retained resources');
  const root = stat(store.root);
  check(root?.isDirectory() && !root.isSymbolicLink() && root.dev === store.rootIdentity.dev
    && root.ino === store.rootIdentity.ino && fs.realpathSync(store.root) === store.root,
  'STALE', 'Runner root identity changed');
  const container = path.join(store.root, 'workspaces'), parent = stat(container);
  if (parent) {
    check(parent.isDirectory() && !parent.isSymbolicLink() && fs.realpathSync(container) === container,
      'STALE', 'Workspace container changed');
    check(stat(path.join(container, key)) === null, 'CONFLICT', 'Unregistered workspace directory or link exists');
  }
  return { identity: Object.fromEntries(keys.map(field => [field, identity[field]])), absent: true,
    ...(seal ? { closed: true, request_id: seal.request_id, operation_id: JSON.parse(seal.identity_json).operation_id,
      request_fingerprint: seal.fingerprint } : {}) };
}

/** Short immediate transactions exclude registration/request writers. Inspection does not mutate. */
export function inspectUnpreparedWorkspace(ctx, params) {
  check(Object.keys(params).length === 0, 'INVALID_REQUEST', 'Preparation inspection accepts no parameters');
  return ctx.store.transaction(() => proof(ctx));
}

/** No directory, Git or model work. The durable fence also blocks future/delayed registrations.
 * A lost reply is recovered by inspection of this same seal, not a new mutation or request ID.
 */
export function closeUnpreparedWorkspace(ctx, params) {
  check(Object.keys(params).length === 0, 'INVALID_REQUEST', 'Preparation closure accepts no parameters');
  return ctx.store.transaction(() => {
    proof(ctx, true);
    const fingerprint = hash(stable({ method: ctx.request.method, identity: ctx.identity, params }));
    ctx.store.db.query('INSERT INTO workspace_closures VALUES (?,?,?,?,?,?,?)')
      .run(ctx.identity.project_id, ctx.identity.worker_id, ctx.identity.workspace_id, workspaceKey(ctx.identity),
        JSON.stringify(ctx.identity), ctx.request_id, fingerprint);
    return proof(ctx);
  });
}
