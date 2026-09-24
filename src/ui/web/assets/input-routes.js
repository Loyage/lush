/**
 * 浏览器侧的快速路由前缀匹配：给输入框高亮用，规则与 src/core/input-routes.js 完全一致。
 *
 * 浏览器不能 import 服务端核心模块，所以这里是同一套确定性规则的前端副本；两边的行为由
 * test/web/input-routes-parity.test.js 用同一组用例逐条比对锁住，任何一侧漂移都会测试失败。
 * 只有纯字符串逻辑，没有 DOM 依赖，node 测试也能直接 import。
 */

export const ROUTE_TARGETS = ['worker', 'research'];

/** 与 core 相同的默认前缀表，仅供没有运行设置快照时回退展示。 */
export const DEFAULT_INPUT_ROUTES = [
  { prefix: '开发', target: 'worker' },
  { prefix: '解释', target: 'research' },
];

/** 输入框高亮只做展示；真正的派活目标由 core 的前缀表决定，这里不保存任何状态。 */
export function matchInputRoute(routes, content) {
  if (typeof content !== 'string') return null;
  const text = content.replace(/^\s+/u, '');
  if (text.length === 0) return null;
  const ordered = [...routes].sort((a, b) => b.prefix.length - a.prefix.length || 0);
  for (const route of ordered) {
    const head = text.slice(0, route.prefix.length);
    if (head.toLowerCase() !== route.prefix.toLowerCase()) continue;
    const rest = text.slice(route.prefix.length);
    if (rest.length > 0 && /[\p{L}\p{N}]/u.test(rest[0])) continue;
    const stripped = rest.replace(/^[\s\p{P}]+/u, '').trim();
    return { prefix: route.prefix, target: route.target, content: stripped };
  }
  return null;
}
