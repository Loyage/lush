import path from 'node:path';
import { check, isPlainObject } from '../core/types.js';
import { launcherStateDir } from './registry.js';

const PREFERENCES = ['markdown', 'theme', 'sidebarSort', 'taskGraphMinimal', 'reduceMotion',
  'polling', 'toastDuration', 'transcriptOrder', 'noticeChannels', 'noticeNotifications'];
const INBOX_STATUSES = ['all', 'open', 'unread', 'automatic', 'failed'];
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
  const automationError = '全局自动化操作未确认，请重新读取策略并检查私有文件权限后重试。';
  const inboxError = '收件箱操作未确认，请刷新记录并检查来源项目的后台状态；已提交的动作不能据此视为未执行。';
  return {
    async readPreferences() { return invoke(preferences, 'get', [], preferenceError); },
    async savePreferences(body) {
      fields(body, ['patch', 'expected_revision'], 'preferences request', ['patch', 'expected_revision']);
      fields(body.patch, PREFERENCES, 'preferences patch');
      check(Object.keys(body.patch).length > 0, 'preferences patch cannot be empty');
      revision(body.expected_revision);
      return invoke(preferences, 'save', [body.patch, body.expected_revision], preferenceError);
    },
    async readAutomation() { return invoke(automation, 'get', [], automationError); },
    async saveAutomation(body) {
      fields(body, ['patch', 'expected_revision'], 'automation request', ['patch', 'expected_revision']);
      fields(body.patch, ['auto_select', 'completion_defaults'], 'automation patch');
      check(Object.keys(body.patch).length > 0, 'automation patch cannot be empty');
      revision(body.expected_revision);
      if (Object.hasOwn(body.patch, 'auto_select')) {
        fields(body.patch.auto_select, ['enabled'], 'auto_select', ['enabled']);
        check(typeof body.patch.auto_select.enabled === 'boolean', 'auto_select enabled must be boolean');
      }
      if (Object.hasOwn(body.patch, 'completion_defaults')) {
        const defaults = body.patch.completion_defaults;
        fields(defaults, ['enabled', 'level'], 'completion_defaults');
        check(Object.keys(defaults).length > 0, 'completion_defaults patch cannot be empty');
        if (Object.hasOwn(defaults, 'enabled')) check(typeof defaults.enabled === 'boolean', 'completion_defaults enabled must be boolean');
        if (Object.hasOwn(defaults, 'level')) check(['merge', 'accept', 'archive'].includes(defaults.level), 'invalid completion_defaults level');
      }
      return invoke(automation, 'save', [body.patch, body.expected_revision], automationError);
    },
    async listInbox(query = {}) {
      fields(query, ['status', 'before', 'limit'], 'inbox query');
      const status = query.status ?? 'all', before = query.before ?? null, limit = query.limit ?? 30;
      check(INBOX_STATUSES.includes(status), 'invalid inbox status');
      check(before === null || (typeof before === 'string' && before.length > 0 && before.length <= 4096), 'invalid inbox cursor');
      check(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'inbox limit must be 1..100');
      return invoke(inbox, 'list', [{ status, before, limit }], inboxError);
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
      return closing ||= Promise.allSettled([preferences.close(), automation.close(), inbox.close()]);
    },
  };
}
