import path from 'node:path';
import { check, isPlainObject } from '../core/types.js';
import { launcherStateDir } from './registry.js';
import { normalizeInboxQuery } from '../ui/web/assets/inbox-query.js';

const PREFERENCES = ['markdown', 'theme', 'sidebarSort', 'taskGraphMinimal', 'reduceMotion',
  'polling', 'toastDuration', 'transcriptOrder', 'noticeChannels', 'noticeNotifications'];
const NOTICE_ACTIONS = ['notice.answer', 'notice.dismiss', 'notice.read'];
function fields(value, allowed, name, required = []) {
  check(isPlainObject(value) && Object.keys(value).every(key => allowed.includes(key))
    && required.every(key => Object.hasOwn(value, key)), `invalid ${name} fields`);
}
function revision(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 200, 'expected_revision required');
}
function projectId(value) {
  check(typeof value === 'string' && /^[a-f0-9]{16}$/.test(value), 'registered project identity required');
}
function noticeId(value) {
  check(Number.isSafeInteger(value) && value > 0, 'positive Notice id required');
}

/** Host-only adapters: no mutable current project, credentials, daemon startup or model calls. */
export function createUserServices(projectHost, options = {}) {
  const env = options.env || process.env;
  const home = path.join(launcherStateDir(env), 'shared');
  const config = { project: null, home, deviceHome: home, env: { ...env } };
  let closed = false, closing = null;
  function registered(value) {
    projectId(value);
    check(projectHost.hasRoute?.(value) === true, 'unknown or inaccessible project identity');
  }
  // Publish the Promise before importing/constructing. Concurrent first requests share one service;
  // shutdown also waits for construction and prevents a late factory from escaping its lifecycle.
  function lazy(factory) {
    let pending = null;
    return {
      get() {
        check(!closed, 'user workspace services are stopping');
        return pending ||= Promise.resolve().then(factory);
      },
      async close() {
        if (!pending) return;
        const service = await pending;
        await service.close?.();
      },
    };
  }
  const preferences = lazy(async () => {
    if (options.preferencesService) return options.preferencesService;
    const { readDevicePreferences, saveDevicePreferences } = await import('../core/device-preferences.js');
    return { get: () => readDevicePreferences(config), save: (patch, expected) => saveDevicePreferences(config, patch, expected) };
  });
  const dashboard = lazy(async () => {
    if (options.dashboardService) return options.dashboardService;
    const { readDashboardSettings, saveDashboardSettings } = await import('../core/dashboard-settings.js');
    return { get: () => readDashboardSettings(config), save: (patch, expected) => saveDashboardSettings(config, patch, expected) };
  });
  const managementPermissions = lazy(async () => {
    if (options.managementPermissionsService) return options.managementPermissionsService;
    const { readDeviceManagementPermissions, saveDeviceManagementPermissions } = await import('../core/management-permissions.js');
    return { get: () => readDeviceManagementPermissions(config), save: (permissions, expected) => saveDeviceManagementPermissions(config, permissions, expected) };
  });
  const automation = lazy(async () => {
    if (options.automationService) return options.automationService;
    const { DeviceAutomationSettings } = await import('../core/device-automation.js');
    return new DeviceAutomationSettings(config);
  });
  const inbox = lazy(async () => {
    if (options.inboxService) return options.inboxService;
    const { GlobalInboxService } = await import('./global-inbox.js');
    return new GlobalInboxService(projectHost, { ...options.inboxOptions, env });
  });
  const push = lazy(async () => {
    if (options.pushService) return options.pushService;
    const { WebPushService } = await import('./web-push-service.js');
    return new WebPushService(projectHost, { ...options.pushOptions, config, authScope: options.pushAuthScope,
      preferences: async () => (await service(preferences)).get() });
  });
  async function service(store) {
    const instance = await store.get();
    check(!closed, 'user workspace services are stopping');
    return instance;
  }
  async function invoke(store, method, args, message) {
    try { return await (await service(store))[method](...args); }
    catch { throw new Error(message); }
  }
  const preferenceError = '设备偏好操作未确认，请重新读取设置并检查私有文件权限后重试。';
  const dashboardError = '总览卡片操作未确认，请重新读取设置并检查私有文件权限后重试。';
  const dashboardSaveError = '总览卡片保存操作未确认，可能版本已变更，请保留编辑并重新读取设置、检查私有文件权限后重试。';
  const managementPermissionsError = '设备管家权限操作未确认，可能版本已变更；请保留草稿，重新读取权限并检查私有文件权限后重试。';
  const automationError = '全局自动化操作未确认，请重新读取策略并检查私有文件权限后重试。';
  const inboxError = '收件箱操作未确认，请刷新记录并检查来源项目的后台状态；已提交的动作不能据此视为未执行。';
  const pushError = '后台推送操作未确认；请核对 HTTPS、浏览器订阅、推送服务网络及私有配置权限后重试。';
  return {
    async start() { return (await service(push)).start(); },
    async readPushConfig() { return invoke(push, 'config', [], pushError); },
    async subscribePush(body, origin) {
      fields(body, ['subscription'], 'push subscription request', ['subscription']);
      return invoke(push, 'subscribe', [body.subscription, origin], pushError);
    },
    async pushStatus(body, origin) {
      fields(body, ['endpoint'], 'push status request', ['endpoint']);
      return invoke(push, 'status', [body.endpoint, origin], pushError);
    },
    async unsubscribePush(body, origin) {
      fields(body, ['endpoint'], 'push unsubscribe request', ['endpoint']);
      return invoke(push, 'unsubscribe', [body.endpoint, origin], pushError);
    },
    async testPush(body, origin) {
      fields(body, ['endpoint'], 'push test request', ['endpoint']);
      return invoke(push, 'test', [body.endpoint, origin], pushError);
    },
    async readPreferences() { return invoke(preferences, 'get', [], preferenceError); },
    async savePreferences(body) {
      fields(body, ['patch', 'expected_revision'], 'preferences request', ['patch', 'expected_revision']);
      fields(body.patch, PREFERENCES, 'preferences patch');
      check(Object.keys(body.patch).length > 0, 'preferences patch cannot be empty');
      revision(body.expected_revision);
      const model = await invoke(preferences, 'save', [body.patch, body.expected_revision], preferenceError);
      if (options.pushAuthScope && (Object.hasOwn(body.patch, 'noticeNotifications') || Object.hasOwn(body.patch, 'noticeChannels'))) {
        // The preference has already committed. A failed transport update must not misreport that write.
        try { (await service(push)).preferencesChanged(model, body.patch); } catch { /* Sender rechecks authority before every delivery. */ }
      }
      return model;
    },
    async readDashboard() { return invoke(dashboard, 'get', [], dashboardError); },
    async saveDashboard(body) {
      fields(body, ['cards', 'hidden_projects', 'layout', 'content', 'account_view', 'widgets', 'diagnostics', 'quick_actions', 'quick_action_buttons', 'expected_revision'], 'dashboard request', ['expected_revision']);
      const { expected_revision, ...patch } = body;
      const { normalizeDashboardPatch } = await import('../core/dashboard-settings.js');
      const normalized = normalizeDashboardPatch(patch);
      check(typeof expected_revision === 'string' && /^[a-f0-9]{64}$/.test(expected_revision), 'dashboard revision is required');
      return invoke(dashboard, 'save', [normalized, expected_revision], dashboardSaveError);
    },
    async readManagementPermissions() { return invoke(managementPermissions, 'get', [], managementPermissionsError); },
    async saveManagementPermissions(body) {
      fields(body, ['permissions', 'expected_revision'], 'management permissions request', ['permissions', 'expected_revision']);
      const { normalizeManagementPermissions } = await import('../core/management-permissions.js');
      const permissions = normalizeManagementPermissions(body.permissions);
      revision(body.expected_revision);
      return invoke(managementPermissions, 'save', [permissions, body.expected_revision], managementPermissionsError);
    },
    async readAutomation() { return invoke(automation, 'get', [], automationError); },
    async saveAutomation(body) {
      fields(body, ['patch', 'expected_revision'], 'automation request', ['patch', 'expected_revision']);
      check(!body.patch || !Object.hasOwn(body.patch, 'completion_defaults'),
        'device completion_defaults write retired; configure project automation settings instead');
      fields(body.patch, ['auto_select'], 'automation patch');
      check(Object.keys(body.patch).length > 0, 'automation patch cannot be empty');
      revision(body.expected_revision);
      if (Object.hasOwn(body.patch, 'auto_select')) {
        fields(body.patch.auto_select, ['enabled'], 'auto_select', ['enabled']);
        check(typeof body.patch.auto_select.enabled === 'boolean', 'auto_select enabled must be boolean');
      }
      return invoke(automation, 'save', [body.patch, body.expected_revision], automationError);
    },
    async listInbox(query = {}) {
      fields(query, ['categories', 'status', 'q', 'project_id', 'before', 'limit'], 'inbox query');
      const normalized = normalizeInboxQuery(query), before = query.before ?? null, limit = query.limit ?? 30;
      check(before === null || (typeof before === 'string' && before.length > 0 && before.length <= 4096), 'invalid inbox cursor');
      check(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'inbox limit must be 1..100');
      return invoke(inbox, 'list', [{ ...normalized, before, limit }], inboxError);
    },
    async getNotice(query) {
      fields(query, ['project_id', 'id'], 'notice query', ['project_id', 'id']);
      registered(query.project_id); noticeId(query.id);
      return invoke(inbox, 'get', [query.project_id, query.id], inboxError);
    },
    async actionInbox(body) {
      fields(body, ['project_id', 'id', 'method', 'answer', 'expected_identity'], 'notice action', ['project_id', 'id', 'method']);
      registered(body.project_id); noticeId(body.id);
      if (Object.hasOwn(body, 'expected_identity')) {
        check(typeof body.expected_identity === 'string' && body.expected_identity.length > 0
          && body.expected_identity.length <= 200, 'expected_identity must be a bounded record identity');
      }
      check(NOTICE_ACTIONS.includes(body.method), 'notice action not allowed');
      check(body.method === 'notice.answer' ? Object.hasOwn(body, 'answer') : !Object.hasOwn(body, 'answer'), 'answer only belongs to notice.answer');
      return invoke(inbox, 'action', [body], inboxError);
    },
    close() {
      closed = true;
      return closing ||= Promise.allSettled([push.close(), preferences.close(), dashboard.close(), managementPermissions.close(), automation.close(), inbox.close()]);
    },
  };
}
