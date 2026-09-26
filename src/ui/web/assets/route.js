/**
 * 当前页面的项目身份只来自地址本身：`/p/<id>/...` 是本页所属项目，`/` 表示单项目模式或全局项目列表。
 *
 * 这是多项目隔离的根据：标签页 A 的每个请求都带 A 的 `/p/<id>/`，服务端按 ID 校验；
 * 任何「全局最后选中的项目」都不会改变这个页面的请求目标，所以别的标签页切项目不可能把
 * A 的写操作送到 B。模块不 import 任何东西，`api.js` 与 `prefs.js` 都以它为准。
 */
const ROUTE = /^\/p\/([a-z0-9]{16})(?:\/|$)/;

function pathname() { return globalThis.location?.pathname || '/'; }

/** 本页所属项目的路由 ID；不在项目页面（单项目模式或全局列表）时为 null。 */
export function projectRoute() {
  return ROUTE.exec(pathname())?.[1] ?? null;
}

/** 本页项目的 URL 前缀（`/p/<id>`）；单项目模式 / 全局根为空。 */
export function projectBase() {
  const id = projectRoute();
  return id ? `/p/${id}` : '';
}

/**
 * 把站内项目 API 路径挂到本页项目前缀下：`/api/task/1` → `/p/<id>/api/task/1`。
 * 启动器与随代码发布的文档是宿主级资源，始终留在无前缀路径（它们不属于任何项目）。
 */
export function projectApi(path) {
  const base = projectBase();
  if (!base || !path.startsWith('/api/')) return path;
  if (path.startsWith('/api/launcher') || path.startsWith('/api/docs')) return path;
  return `${base}${path}`;
}

/** 打开某个项目的地址；`suffix` 带 hash 时可直接深链接到任务或页面。 */
export function projectHref(id, suffix = '/') {
  return `/p/${id}${suffix}`;
}
