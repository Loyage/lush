import { check } from '../types.js';
import { hookRevision } from '../hooks.js';
import { acquireConfigurationLock } from '../device-config.js';
import { managementPermissionsView, normalizeManagementPermissions, readDeviceManagementPermissions } from '../management-permissions.js';

const KEY = 'management_permissions';
const initial = () => ({ version: 1, generation: 0, permissions: {} });
const stored = project => JSON.parse(project.store.get('SELECT value FROM meta WHERE key=?', KEY)?.value ?? JSON.stringify(initial()));
export default {
  managementPermissions() {
    if (this.config.deviceHome) {
      const shared = readDeviceManagementPermissions(this.config);
      if (shared.configured) return shared;
    }
    return managementPermissionsView(stored(this));
  },
  managementPermissionsSnapshot() {
    const { version, scope, revision, permissions } = this.managementPermissions();
    return { version, scope, revision, permissions };
  },

  /** Synchronous start-admission linearization, shared with Host publication.
   * Release before awaiting any effect: once durably started, tightening does not kill it.
   * Nested synchronous action admission belongs to the same start, not a second lock.
   */
  withManagementPermissionAdmission(fn) {
    if (!this.config.deviceHome || this.managementPermissionAdmission) return fn();
    const lock = acquireConfigurationLock(this.config, 'device');
    try {
      lock.assert(); this.managementPermissionAdmission = true;
      return fn();
    } finally { this.managementPermissionAdmission = false; lock.release(); }
  },

  // Internal legacy writer retained for old project fixtures/migrations only. Public RPC writes
  // are retired. It cannot replace configured device authority or perform the first global save.
  setManagementPermissions(permissions, expectedRevision) {
    this.assertWritable('configure management permissions');
    const normalized = normalizeManagementPermissions(permissions);
    this.withManagementPermissionAdmission(() => {
      check(!this.config.deviceHome || !readDeviceManagementPermissions(this.config).configured,
        'project management permissions are historical; use /api/host/management/permissions');
      this.store.transaction(() => {
        const current = stored(this);
        check(typeof expectedRevision === 'string' && expectedRevision === hookRevision(current), 'management permissions revision changed; reload before editing');
        const next = { version: 1, generation: current.generation + 1, permissions: normalized };
        this.store.run('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', KEY, JSON.stringify(next));
        this.store.event(null, 'management.permissions_updated', { scope: 'project', revision: hookRevision(next) });
      });
    });
    this.drainManagementActions();
    return this.managementPermissions();
  },

  refreshManagementPermissions() {
    if (this.stopping) return;
    try {
      const current = this.managementPermissions();
      const revision = `${current.scope}:${current.revision}`;
      if (this.managementPermissionsObservedRevision === revision) return;
      this.drainManagementActions();
      this.managementPermissionsObservedRevision = revision;
      this.managementPermissionsIssue = null;
    } catch {
      // Never fall back to project permissions when shared storage is unsafe/unreadable.
      this.managementPermissionsIssue = 'device management permissions unavailable; unstarted operations remain subject to final authorization';
    }
  },
  startManagementPermissionsMonitor() {
    if (this.managementPermissionsMonitor || this.stopping) return;
    this.refreshManagementPermissions();
    this.managementPermissionsMonitor = setInterval(() => this.refreshManagementPermissions(), 1000);
    this.managementPermissionsMonitor.unref?.();
  },
  stopManagementPermissionsMonitor() {
    clearInterval(this.managementPermissionsMonitor); this.managementPermissionsMonitor = null;
  },
};
