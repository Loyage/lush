import { createHash } from 'node:crypto';
import { check, isPlainObject } from '../../core/types.js';
import { diagnosticsSearch } from '../../core/diagnostics-query.js';
import { WEB_PUSH_PATHS } from '../../shared/web-push-protocol.js';
import { projectRouteId } from '../../host/registry.js';
import { cliCatalog } from '../../rpc/cli-catalog.js';
import { capabilitySource } from '../../agent/capabilities.js';
import { createUserServices } from '../../host/user-services.js';
import { validateAppearanceUpdate } from '../../host/project-appearance.js';
import { DeviceSettingsService, DEVICE_SETTINGS_READS, DEVICE_SETTINGS_ACTIONS } from '../../host/device-settings.js';
import { emptyJson, settingQuery, userQuery, userBody } from './server-query.js';
import { administratorControl } from '../../host/administrator.js';
import { createAdministratorHostRoutes } from './server-administrator-routes.js';
import { deviceValetControl } from '../../host/device-valet.js';
import { createDeviceValetHostRoutes } from './server-device-valet-routes.js';

/** Root-only Host routes precede project identity normalization; services stay lazy. */
export function createHostRoutes(projectHost, auth, options, env) {
  let hostRestarting = false;
  let deviceSettings = null, userServices = null;
  const getDeviceSettings = () => deviceSettings ||= options.deviceSettingsService || new DeviceSettingsService(env, options.deviceSettingsOptions);
  // Bind persisted subscriptions to the loaded authentication policy, not an expiring login session.
  const pushAuthScope = createHash('sha256').update(JSON.stringify([auth.username, auth.password_hash,
    auth.origins, auth.projects, auth.config_home])).digest('hex');
  const getUserServices = () => userServices ||= createUserServices(projectHost, { ...options.userServiceOptions, env, pushAuthScope });
  const pushRequestOrigin = ({ request, url, user }) => {
    check(user?.kind === 'user_session', 'Web Push requires a logged-in user');
    const value = request.headers.get('origin') || (auth.origins?.length === 1 ? auth.origins[0] : url.origin);
    check(value !== 'null' && (value === url.origin || auth.origins?.includes(value)), 'invalid Web Push request origin');
    return value;
  };
  const administrator = createAdministratorHostRoutes(administratorControl(env, options.administratorOptions));
  const deviceControl = deviceValetControl(env, options.deviceValetOptions);
  const deviceValet = createDeviceValetHostRoutes(deviceControl);
  return {
    // startWeb owns this lifecycle hook; subscription POST also starts a newly enabled sender.
    async start() { await getUserServices().start(); },
    async handle(context) {
      const { request, url, headers, json } = context;
      const device = await deviceValet(context);
      if (device) return device;
      const privileged = await administrator(context);
      if (privileged) return privileged;
      // These root-only reads never attach a project or instantiate device services.
      if (/^\/p\/[a-z0-9]{16}\/api\/host\/(?:session|skills)$/.test(url.pathname)) return json({ error: 'not found' }, 404);
      if (url.pathname === '/api/host/cli/catalog') {
        check(request.method === 'GET' && !url.search, 'CLI catalog requires GET without query parameters');
        return json(cliCatalog());
      }
      if (url.pathname === '/api/host/skills') {
        if (request.method !== 'GET') return json({ error: 'not found' }, 404);
        const query = userQuery(url, ['id']);
        check(typeof query.id === 'string', 'built-in Skill id required');
        return json(capabilitySource(query.id));
      }
      if (url.pathname === '/api/host/session') {
        if (request.method !== 'GET') return json({ error: 'not found' }, 404);
        userQuery(url, []);
        return json({ username: auth.username });
      }
      // Retired paths cannot attach projects or forward to an older daemon.
      if (/^(?:\/p\/[a-z0-9]{16})?\/api\/(?:host\/(?:settings\/)?)?(?:quick-chat|quick-explain)(?:\/|$)/.test(url.pathname)) return json({ error: 'not found' }, 404);
      // ---- 宿主级路由：启动器等不属于任何项目的接口先于项目路由匹配 ----
      if (['/api/host/preferences', '/api/host/automation', '/api/host/dashboard', '/api/host/management/permissions'].includes(url.pathname)) {
        const methods = {
          '/api/host/preferences': ['readPreferences', 'savePreferences'],
          '/api/host/automation': ['readAutomation', 'saveAutomation'],
          '/api/host/dashboard': ['readDashboard', 'saveDashboard'],
          '/api/host/management/permissions': ['readManagementPermissions', 'saveManagementPermissions'],
        }[url.pathname];
        if (request.method === 'GET') {
          userQuery(url, []);
          return json(await getUserServices()[methods[0]]());
        }
        if (request.method === 'POST') {
          const body = await userBody(request, url);
          return json(await getUserServices()[methods[1]](body));
        }
        return json({ error: 'not found' }, 404);
      }
      if (url.pathname === WEB_PUSH_PATHS.config) {
        if (request.method !== 'GET') return json({ error: 'not found' }, 404);
        userQuery(url, []); pushRequestOrigin(context);
        return json(await getUserServices().readPushConfig());
      }
      const pushAction = {
        [WEB_PUSH_PATHS.subscribe]: 'subscribePush', [WEB_PUSH_PATHS.unsubscribe]: 'unsubscribePush',
        [WEB_PUSH_PATHS.status]: 'pushStatus', [WEB_PUSH_PATHS.test]: 'testPush',
      }[url.pathname];
      if (pushAction) {
        if (request.method !== 'POST') return json({ error: 'not found' }, 404);
        const origin = pushRequestOrigin(context);
        return json(await getUserServices()[pushAction](await userBody(request, url), origin));
      }
      if (url.pathname === '/api/host/diagnostics/query') {
        if (request.method !== 'GET') return json({ error: 'not found' }, 404);
        return json(await projectHost.queryDiagnostics(diagnosticsSearch(url.searchParams, true), request.signal));
      }
      if (url.pathname === '/api/host/diagnostics') {
        if (request.method !== 'GET') return json({ error: 'not found' }, 404);
        userQuery(url, []);
        return json(await projectHost.diagnostics());
      }
      if (request.method === 'GET' && url.pathname === '/api/host/inbox') {
        const query = userQuery(url, ['categories', 'status', 'q', 'project_id', 'before', 'limit']);
        if (Object.hasOwn(query, 'categories')) {
          try { query.categories = JSON.parse(query.categories); }
          catch { throw new Error('inbox categories must be a JSON array'); }
        }
        if (Object.hasOwn(query, 'limit')) {
          check(/^[1-9]\d*$/.test(query.limit), 'inbox limit must be a positive integer');
          query.limit = Number(query.limit);
        }
        return json(await getUserServices().listInbox(query));
      }
      if (request.method === 'GET' && url.pathname === '/api/host/inbox/notice') {
        const query = userQuery(url, ['project_id', 'id']);
        check(typeof query.id === 'string' && /^[1-9]\d*$/.test(query.id), 'positive Notice id required');
        query.id = Number(query.id);
        return json(await getUserServices().getNotice(query));
      }
      if (request.method === 'POST' && url.pathname === '/api/host/inbox/action') {
        return json(await getUserServices().actionInbox(await userBody(request, url)));
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/host/settings/')) {
        const suffix = url.pathname.slice('/api/host/settings/'.length), spec = DEVICE_SETTINGS_READS.get(suffix);
        if (!spec) return json({ error: 'not found' }, 404);
        return json(await getDeviceSettings().request(spec[0], settingQuery(url, spec[1], true)));
      }
      if (request.method === 'POST' && url.pathname === '/api/host/settings/action') {
        check(!url.search, 'settings action accepts no query parameters');
        check(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'application/json required');
        const body = await request.json();
        check(isPlainObject(body) && Object.keys(body).every(key => ['method', 'params'].includes(key))
          && DEVICE_SETTINGS_ACTIONS.has(body.method), 'method not allowed from Host settings');
        check(isPlainObject(body.params) && !Object.hasOwn(body.params, '_token'), 'settings params required; agent tokens are not accepted');
        return json(await getDeviceSettings().request(body.method, body.params));
      }
      if (request.method === 'GET' && url.pathname === '/api/host') return json({ ...await projectHost.status(),
        pid: process.pid, restart_supported: typeof options.restartHost === 'function', project_control: true });
      if (request.method === 'POST' && url.pathname === '/api/host/restart') {
        await emptyJson(request);
        check(typeof options.restartHost === 'function', '当前嵌入界面不支持重启服务，请使用命令行重启 Host');
        check(!hostRestarting, '界面服务已经在重启，请稍后再试');
        hostRestarting = true;
        // Let Bun flush the small acceptance response before releasing the listener.
        setTimeout(() => options.restartHost(), 200);
        return json({ restarting: true });
      }
      const appearanceRoute = /^\/api\/host\/projects\/([a-f0-9]{16})\/appearance$/.exec(url.pathname);
      if (appearanceRoute && ['GET', 'POST'].includes(request.method)) {
        check(!url.search, 'project appearance accepts no query parameters or agent tokens');
        if (request.method === 'GET') {
          check(typeof projectHost.appearance === 'function', 'project appearance is unavailable');
          return json(await projectHost.appearance(appearanceRoute[1]));
        }
        check(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'application/json required');
        const body = validateAppearanceUpdate(await request.json());
        check(typeof projectHost.saveAppearance === 'function', 'project appearance is unavailable');
        return json(await projectHost.saveAppearance(appearanceRoute[1], body));
      }
      if (request.method === 'GET' && url.pathname === '/api/host/projects') return json({ projects: await projectHost.projects() });
      if (request.method === 'POST' && ['/api/host/projects/start', '/api/host/projects/stop'].includes(url.pathname)) {
        check(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'application/json required');
        const body = await request.json();
        check(isPlainObject(body) && Object.keys(body).length === 1 && typeof body.id === 'string' && /^[a-f0-9]{16}$/.test(body.id),
          'project control body must contain only a registered project id');
        const method = url.pathname.endsWith('/start') ? 'start' : 'stop';
        check(typeof projectHost[method] === 'function', 'project background control is unavailable');
        return json(await projectHost[method](body.id));
      }
      if (request.method === 'POST' && url.pathname === '/api/host/select') {
        check(projectHost.launcher, 'project switching is disabled for this Web UI');
        check(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'application/json required');
        const body = await request.json();
        const project = await projectHost.select(body?.project);
        // 只登记 / 连接并回传稳定身份；页面归属由前端跳到该项目的 /p/<id>/ 决定，不在服务端留「当前项目」。
        return json({ ...await projectHost.status(), id: projectRouteId(project), project });
      }
      if (request.method === 'POST' && url.pathname === '/api/host/remove') {
        check(projectHost.launcher, 'project removal is disabled for this Web UI');
        check(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'application/json required');
        const body = await request.json();
        return json(projectHost.remove(body?.id));
      }
      return null;
    },
    async close(stopped) {
      await Promise.allSettled([stopped, userServices?.close()]);
      await Promise.allSettled([deviceSettings?.stop(), deviceControl.close()]);
    },
  };
}
