import { webStaticAssets } from './static-assets.js';
import { launcherWebConfig } from '../../host/registry.js';
import { createProjectHost } from '../../host/project-host.js';
import { check } from '../../core/types.js';
import { loadAuth, createAuthHandler } from './server-auth.js';
import { createHostRoutes } from './server-host-routes.js';
import { projectRoutes } from './server-project-routes.js';
import { PROJECT_ELEVATION_HTTP, PROJECT_ELEVATION_HTTP_BYTES } from '../../administrator/project-protocol.js';

const WEB_HOSTS = new WeakMap();
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export function startWeb(config, port = 4318, options = {}) {
  check(Number.isInteger(port) && port >= 0 && port <= 65535, 'invalid web port');
  const env = options.env || config?.env || process.env;
  const launcher = !config;
  const authConfig = options.authConfig === undefined ? (config || launcherWebConfig(env)) : options.authConfig;
  check(authConfig, 'Web 登录配置不可禁用；请手工配置对应作用域的 web.json');
  const auth = loadAuth(authConfig, { launcher });
  const projectHost = options.projectHost || createProjectHost(config, { ...options, env, allowedProjects: launcher ? auth?.projects : null });
  // Build once before listening; preserve the synchronous startWeb -> Bun server contract.
  const staticAssets = webStaticAssets();
  const authenticate = createAuthHandler(auth);
  const hostRoutes = createHostRoutes(projectHost, auth, options, env);
  const server = Bun.serve({
    hostname: auth.hostname, port, maxRequestBodySize: PROJECT_ELEVATION_HTTP_BYTES,
    async fetch(request, server) {
      const url = new URL(request.url);
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': PAGE_CSP };
      const json = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { ...headers, ...extra } });
      // Preserve existing endpoint budgets; only the exact project password entrance
      // needs room for JSON-escaped confirmed text. Legacy global creation is retired.
      const administratorInput = request.method === 'POST'
        && url.pathname.replace(/^\/p\/[a-z0-9]{16}/, '') === PROJECT_ELEVATION_HTTP.submit;
      if (request.method === 'POST' && !administratorInput && (await request.clone().arrayBuffer()).byteLength > 128 * 1024)
        return json({ error: 'request body exceeds 128 KiB' }, 413);
      const context = { request, server, url, headers, json };
      const guarded = await authenticate(context);
      if (guarded) return guarded;
      try {
        const host = await hostRoutes.handle(context);
        if (host) return host;
        return await projectRoutes(context, projectHost, staticAssets);
      } catch (error) { return json({ error: error.message }, 400); }
    },
  });
  const stop = server.stop.bind(server);
  server.stop = async closeActiveConnections => {
    await hostRoutes.close(stop(closeActiveConnections));
  };
  WEB_HOSTS.set(server, projectHost);
  if (auth.version === 1) console.warn('[web] 旧版 version:1 web.json 保留全接口监听；改为 version:2 可默认仅监听回环，公网需显式 listen:"public"。');
  if (auth.hostname === '0.0.0.0') console.warn('[web] 公网 HTTP 监听已启用；直接通过 HTTP 访问会明文传输账号密码、会话和项目数据，存在窃听与篡改风险。建议由用户配置 HTTPS 反向代理或 SSH 端口转发；HTTP 不会因此被拒绝。');
  return server;
}

/** 进程正常关闭时再记一次当前项目：Web 与桌面并开时，以最后关闭的实例为准。 */
export function rememberWebProject(server) {
  try { WEB_HOSTS.get(server)?.rememberCurrent(); } catch { /* 缓存失败不能阻止进程退出 */ }
}
