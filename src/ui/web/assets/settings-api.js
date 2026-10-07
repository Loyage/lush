import { api } from './api.js';
import { projectBase } from './route.js';
import { workbenchStatus } from './project-picker.js';

/** A settings-only transport. Worker actions, histories and model calls keep their project API. */
export function settingsClient(scope = 'device') {
  if (!['device', 'project'].includes(scope)) throw new Error('设置作用域无效');
  const context = workbenchStatus(), project = context.projectUsable;
  if (scope === 'project' && !project) throw new Error('打开可用项目后才能编辑项目覆盖');
  const route = projectBase();
  const key = `${project ? route || 'single-project' : 'host'}:${scope}`;
  const isCurrent = () => projectBase() === route && workbenchStatus().projectUsable === project;
  const guard = () => { if (!isCurrent()) throw new Error('项目上下文已改变，请重新打开设置'); };
  const urlFor = url => {
    const parsed = new URL(url, 'http://lush.invalid');
    if (!/^\/api\/(?:settings\/runtime|quick-explain\/config|agent\/(?:config|status|connections|connections\/models|network|environment|models|selection\/resources|packages|resources))$/.test(parsed.pathname)) {
      throw new Error('此请求不属于配置管理 API');
    }
    parsed.searchParams.set('scope', scope);
    if (!project) {
      const suffix = parsed.pathname === '/api/settings/runtime' ? 'runtime' : parsed.pathname.replace(/^\/api\//, '');
      parsed.pathname = `/api/host/settings/${suffix}`;
    }
    return parsed.pathname + parsed.search;
  };
  return { scope, key, project, isCurrent,
    read: async url => {
      guard(); const value = await api(urlFor(url)); guard();
      const path = new URL(url, 'http://lush.invalid').pathname;
      if (['/api/settings/runtime', '/api/agent/config', '/api/agent/connections', '/api/agent/network', '/api/quick-explain/config'].includes(path)
        && (value?.configuration_scope?.selected !== scope || !['device', 'project', 'default', 'mixed'].includes(value.configuration_scope.source))) {
        throw new Error('后台未确认所选设置作用域，请更新 Host 与项目后台；未修改任何配置');
      }
      return value;
    },
    action: async (method, params = {}) => {
      guard();
      if (!/^(?:system\.configure|agent\.configure|agent\.(?:network|environment)\.configure|agent\.packages\.(?:install|remove|update)|quick_explain\.configure|agent\.connections\.(?:save|remove|query|sampling|models\.refresh|device\.(?:start|poll|cancel)|login\.(?:start|finish)))$/.test(method)) {
        throw new Error('此操作不属于配置管理 API');
      }
      const value = await api(project ? '/api/action' : '/api/host/settings/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params: { ...params, scope } }),
    }); guard(); return value; },
  };
}

/** Compatibility for shared subpanels used outside the settings pages, including Worker pickers. */
export function settingsClientFor(model) {
  const scope = model?.configuration_scope?.selected;
  if (scope) return settingsClient(scope);
  const route = projectBase(), isCurrent = () => projectBase() === route;
  const guard = () => { if (!isCurrent()) throw new Error('项目上下文已改变，请重新打开设置'); };
  return { scope: 'project', key: `${route}:legacy`, project: true, isCurrent,
    read: async url => { guard(); const value = await api(url); guard(); return value; },
    action: async (method, params = {}) => { guard(); const value = await api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }) }); guard(); return value; } };
}

export function projectSettingsAction(method, params = {}) {
  if (!workbenchStatus().projectUsable) return Promise.reject(new Error('当前没有可用项目'));
  return api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
}
