import { check, isPlainObject } from '../types.js';
import { hookRevision } from '../hooks.js';
import { MANAGEMENT_GROUPS, managementPermissionMethods } from '../../rpc/management-policy.js';

const KEY = 'management_permissions';
const initial = () => ({ version: 1, generation: 0, permissions: {} });
const stored = project => JSON.parse(project.store.get('SELECT value FROM meta WHERE key=?', KEY)?.value ?? JSON.stringify(initial()));
function view(value) {
  // Defaults may acquire newly reviewed methods; frozen Worker snapshots never do.
  const methods = managementPermissionMethods().map(item => {
    const access = value.permissions[item.method] ?? item.base_access;
    return { ...item, access: item.allowed_access.includes(access) ? access : 'unavailable' };
  });
  return { version: 1, scope: 'project', revision: hookRevision(value), groups: MANAGEMENT_GROUPS.map(group => ({ ...group })),
    methods, permissions: Object.fromEntries(methods.map(item => [item.method, item.access])) };
}
export default {
  managementPermissions() { return view(stored(this)); },
  managementPermissionsSnapshot() {
    const { version, scope, revision, permissions } = this.managementPermissions();
    return { version, scope, revision, permissions };
  },
  setManagementPermissions(permissions, expectedRevision) {
    this.assertWritable('configure management permissions');
    const methods = managementPermissionMethods();
    check(isPlainObject(permissions) && Object.keys(permissions).length === methods.length
      && Object.keys(permissions).every(method => methods.some(item => item.method === method)),
    'permissions must be a complete known method-to-access mapping');
    for (const item of methods) check(Object.hasOwn(permissions, item.method) && item.allowed_access.includes(permissions[item.method]),
      `invalid or elevated management permission: ${item.method}`);
    this.store.transaction(() => {
      const current = stored(this);
      check(typeof expectedRevision === 'string' && expectedRevision === hookRevision(current), 'management permissions revision changed; reload before editing');
      const next = { version: 1, generation: current.generation + 1,
        permissions: Object.fromEntries(methods.map(item => [item.method, permissions[item.method]])) };
      this.store.run('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', KEY, JSON.stringify(next));
      this.store.event(null, 'management.permissions_updated', { scope: 'project', revision: hookRevision(next) });
    });
    return this.managementPermissions();
  },
};
