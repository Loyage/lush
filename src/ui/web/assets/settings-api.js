import { api } from './api.js';

const READS = /^\/api\/(?:settings\/runtime|quick-explain\/config|agent\/(?:config|status|connections|connections\/models|network|environment|models|selection\/resources|packages|resources))$/;
const ACTIONS = /^(?:system\.configure|agent\.configure|agent\.(?:network|environment)\.configure|agent\.packages\.(?:install|remove|update)|quick_explain\.configure|agent\.connections\.(?:save|remove|query|sampling|models\.refresh|device\.(?:start|poll|cancel)|login\.(?:start|finish)))$/;

/** Device configuration always belongs to Host, even when the current project is offline. */
export function settingsClient(scope = 'device') {
  if (scope !== 'device') throw new Error('项目设置覆盖已停用；请编辑设备设置');
  const urlFor = url => {
    const parsed = new URL(url, 'http://lush.invalid');
    if (parsed.origin !== 'http://lush.invalid' || !READS.test(parsed.pathname)) throw new Error('此请求不属于配置管理 API');
    if (parsed.searchParams.has('scope') && parsed.searchParams.get('scope') !== 'device') throw new Error('项目设置覆盖已停用');
    parsed.searchParams.set('scope', 'device');
    const suffix = parsed.pathname === '/api/settings/runtime' ? 'runtime' : parsed.pathname.replace(/^\/api\//, '');
    parsed.pathname = `/api/host/settings/${suffix}`;
    return parsed.pathname + parsed.search;
  };
  return { scope: 'device', key: 'host:device', project: false, isCurrent: () => true,
    read: async url => {
      const value = await api(urlFor(url));
      const path = new URL(url, 'http://lush.invalid').pathname;
      if (['/api/settings/runtime', '/api/agent/config', '/api/agent/connections', '/api/agent/network', '/api/agent/environment', '/api/quick-explain/config'].includes(path)
        && (value?.configuration_scope?.selected !== 'device' || value.configuration_scope.project_override === true
          || !['device', 'default', 'mixed'].includes(value.configuration_scope.source))) {
        throw new Error('Host 未确认设备设置来源，请更新界面服务；未修改任何配置');
      }
      if (path === '/api/agent/connections' && value.connections?.some(row => row.storage_scope === 'project')) {
        throw new Error('Host 返回了旧项目来源；设备来源页拒绝展示，请先更新 Host 或显式迁移');
      }
      return value;
    },
    action: (method, params = {}) => {
      if (!ACTIONS.test(method)) return Promise.reject(new Error('此操作不属于配置管理 API'));
      if (params.scope !== undefined && params.scope !== 'device') return Promise.reject(new Error('项目设置覆盖已停用'));
      if (Object.hasOwn(params, '_token')) return Promise.reject(new Error('设备设置不接受 Agent token'));
      return api('/api/host/settings/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, params: { ...params, scope: 'device' } }) });
    },
  };
}

/** Shared settings subpanels also use the device transport; Worker forms keep their own API. */
export function settingsClientFor(model) {
  if (model?.configuration_scope?.selected && model.configuration_scope.selected !== 'device') throw new Error('项目设置覆盖已停用；请重新读取设备设置');
  return settingsClient();
}

/** Migration is the only settings action addressed to an explicitly selected registered project. */
export function projectSettingsAction(method, params = {}, projectId) {
  if (method !== 'settings.migration.apply') return Promise.reject(new Error('此操作不是旧项目设置迁移'));
  if (typeof projectId !== 'string' || !/^[a-f0-9]{16}$/.test(projectId)) return Promise.reject(new Error('请选择已登记的迁移来源项目'));
  return api(`/p/${projectId}/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }) });
}
