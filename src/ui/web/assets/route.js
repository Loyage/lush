/**
 * 工作台身份只来自地址：本地项目 `/p/<pid>/`，远端环境 `/e/<eid>/`，
 * 远端项目 `/e/<eid>/p/<pid>/`。未知/离线环境仍保留环境身份，绝不回落本地项目。
 */
const PROJECT_ID = '[a-z0-9]{16}';
// 接受有界安全段以便未知/未来环境身份仍保持离线 shell；服务端会进一步校验已知 UUID。
const ENV_ID = '[A-Za-z0-9_-]{1,128}';
const LOCAL_PROJECT = new RegExp(`^/p/(${PROJECT_ID})(?:/|$)`);
const ENVIRONMENT = new RegExp(`^/e/(${ENV_ID})(?:/|$)`);
const ENV_PROJECT = new RegExp(`^/e/(${ENV_ID})/p/(${PROJECT_ID})(?:/|$)`);

function pathname() { return globalThis.location?.pathname || '/'; }

export function routeContext() {
  const path = pathname();
  const remote = ENV_PROJECT.exec(path);
  if (remote) return { environment: remote[1], project: remote[2], remote: true };
  const environment = ENVIRONMENT.exec(path);
  if (environment) return { environment: environment[1], project: null, remote: true };
  const local = LOCAL_PROJECT.exec(path);
  if (!local && /^\/(?:e|p)(?:\/|$)/.test(path)) return { environment: null, project: null, remote: path.startsWith('/e'), invalid: true };
  return { environment: null, project: local?.[1] ?? null, remote: false };
}

export function environmentRoute() { return routeContext().environment; }
export function projectRoute() { return routeContext().project; }

/** 当前环境入口；本地为空。 */
export function environmentBase() {
  const id = environmentRoute();
  return id ? `/e/${encodeURIComponent(id)}` : '';
}

/** 当前项目 API 前缀。环境存在时始终保留 `/e/<id>`，即使项目不存在。 */
export function projectBase() {
  const route = routeContext();
  if (route.environment && route.project) return `/e/${encodeURIComponent(route.environment)}/p/${route.project}`;
  if (route.project) return `/p/${route.project}`;
  return environmentBase();
}

/**
 * 项目 API 跟随环境+项目；`/api/host` 属于当前环境（远端为 `/e/<id>/api/host`）。
 * 只有入口 Host 自己的环境管理 `/api/environments` 与随版本发布的文档永远不经 `/e` 代理。
 */
export function projectApi(path) {
  if (!path.startsWith('/api/')) return path;
  if (path.startsWith('/api/environments') || path.startsWith('/api/docs')) return path;
  if (routeContext().invalid) throw new Error('当前环境或项目地址无效；未回落到本地项目');
  if (path.startsWith('/api/host')) {
    const environment = environmentBase();
    return environment ? `${environment}${path}` : path;
  }
  const base = projectBase();
  return base ? `${base}${path}` : path;
}

export function environmentHref(id, suffix = '/') {
  return `/e/${encodeURIComponent(id)}${suffix}`;
}

/** 默认在当前环境内打开项目；传 null 可显式生成本地项目地址。 */
export function projectHref(id, suffix = '/', environment = environmentRoute()) {
  if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) throw new Error('无效的项目身份');
  return environment ? `/e/${encodeURIComponent(environment)}/p/${id}${suffix}` : `/p/${id}${suffix}`;
}

/** 偏好隔离身份。本地项目继续只用 pid，兼容已有 localStorage 键。 */
export function preferenceScope() {
  const route = routeContext();
  if (route.environment) return route.project ? `e:${route.environment}:p:${route.project}` : `e:${route.environment}`;
  return route.project;
}
