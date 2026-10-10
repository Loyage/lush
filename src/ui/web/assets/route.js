/** 项目身份只来自地址 `/p/<pid>/`；宿主资源不依赖当前项目。 */
const PROJECT = /^\/p\/([a-f0-9]{16})(?:\/|$)/;

export function routeContext() {
  const path = globalThis.location?.pathname || '/';
  const match = PROJECT.exec(path);
  return { project: match?.[1] ?? null, invalid: !match && /^\/p(?:\/|$)/.test(path) };
}

export function projectRoute() { return routeContext().project; }
export function projectBase() {
  const id = projectRoute();
  return id ? `/p/${id}` : '';
}

/** 项目 API 跟随项目；Host 与发布文档始终属于宿主。 */
export function projectApi(path) {
  if (!path.startsWith('/api/')) return path;
  if (path.startsWith('/api/docs')) return path;
  if (routeContext().invalid) throw new Error('当前项目地址无效；未回落到其它项目');
  if (path.startsWith('/api/host')) return path;
  return `${projectBase()}${path}`;
}

export function projectHref(id, suffix = '/') {
  if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) throw new Error('无效的项目身份');
  return `/p/${id}${suffix}`;
}

/** Only explicit project routes are project workspaces, even for a bound Host. */
export function isProjectWorkspace() { return Boolean(projectRoute()); }

export function workspaceHref(hash = '') {
  if (typeof hash !== 'string' || (hash && !/^#[a-z0-9_-]+$/i.test(hash))) throw new Error('无效的工作台地址');
  return `/${hash}`;
}

/** 项目工作状态按身份隔离；主题为设备偏好，项目辨识色另由 Host 保存。 */
export function preferenceScope() { return projectRoute(); }
