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

/** 兼容已有项目 localStorage 视图键；项目主题／配色另由 Host 持久保存。 */
export function preferenceScope() { return projectRoute(); }
