import { check } from '../types.js';
import { acquireConfigurationLock } from '../device-config.js';
import { readDeviceManagementPermissions, saveDeviceManagementPermissions,
  managementPermissionView, saveDeviceManagementPermission } from '../management-permissions.js';
export default {
  managementPermissions() {
    return readDeviceManagementPermissions(this.config);
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
    if (this.managementPermissionAdmission) return fn();
    const lock = acquireConfigurationLock(this.config, this.config.deviceHome ? 'device' : 'project');
    try {
      lock.assert(); this.managementPermissionAdmission = true;
      return fn();
    } finally { this.managementPermissionAdmission = false; lock.release(); }
  },

  // Test-only compatibility for fixtures without a device root. Old meta is
  // never active authority, and real projects cannot establish an override.
  setManagementPermissions(permissions, expectedRevision) {
    this.assertWritable('configure management permissions');
    check(!this.config.deviceHome, 'project management permissions are historical; use device permissions');
    const saved = saveDeviceManagementPermissions(this.config, permissions, expectedRevision);
    this.drainManagementActions();
    return saved;
  },

  managementPermissionGet(method, scope) {
    return managementPermissionView(this.config, method, scope);
  },
  managementPermissionSet(method, access, expectedRevision, scope) {
    this.assertWritable('configure device management permissions');
    return saveDeviceManagementPermission(this.config, method, access, expectedRevision, scope);
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
