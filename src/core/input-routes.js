import { check, isPlainObject } from './types.js';

/**
 * 快速路由前缀：一条输入的正文若以配置的前缀开头，就按前缀直接派活，不调用规划模型。
 *
 * 这里只有确定性的字符串规则，没有副作用，也没有数据库依赖：运行设置读它来校验配置，
 * 输入提交读它来匹配，Web 对齐时也读同一份规则，不会出现两套行为。
 *
 * - target `worker`：可写代码，流程设为 develop；
 * - target `research`：只读调研，流程设为 explain（不创建分支 / worktree）。
 */
export const ROUTE_TARGETS = ['worker', 'research'];

/** 默认前缀表：中文动词开头，配合分隔符规则避免「开发文档」这类正常句子被误判。 */
export const DEFAULT_INPUT_ROUTES = [
  { prefix: '开发', target: 'worker' },
  { prefix: '解释', target: 'research' },
];

/** 前缀表上限：够用即可，避免运行设置文件被无意义地撑大。 */
const MAX_ROUTES = 32;
const MAX_PREFIX = 32;

function routeError(file, index, message) {
  return `${file}${index === null ? '' : `[${index}]`} ${message}`;
}

/**
 * 校验并归一化一份前缀表：0..32 项，每项恰为 {prefix,target}，prefix 非空、≤32 字符且不含空白，
 * target ∈ ROUTE_TARGETS，prefix 按大小写不敏感去重。返回全新数组，调用方拿到的是副本。
 */
export function normalizeInputRoutes(value, file = 'input routes') {
  check(Array.isArray(value), `${file} must be an array`);
  check(value.length <= MAX_ROUTES, `${file} must have at most ${MAX_ROUTES} entries`);
  const seen = new Set();
  const routes = value.map((entry, index) => {
    check(isPlainObject(entry), routeError(file, index, 'must be an object'));
    check(Object.keys(entry).every(key => key === 'prefix' || key === 'target'),
      routeError(file, index, 'must only have prefix and target'));
    check(Object.hasOwn(entry, 'prefix') && Object.hasOwn(entry, 'target'),
      routeError(file, index, 'must have both prefix and target'));
    const { prefix, target } = entry;
    check(typeof prefix === 'string' && prefix.length > 0 && prefix.length <= MAX_PREFIX && !/\s/u.test(prefix),
      routeError(file, index, `prefix must be 1 to ${MAX_PREFIX} non-whitespace characters`));
    check(ROUTE_TARGETS.includes(target), routeError(file, index, 'target must be worker or research'));
    const folded = prefix.toLowerCase();
    check(!seen.has(folded), routeError(file, index, `duplicate prefix ${prefix}`));
    seen.add(folded);
    return { prefix, target };
  });
  return routes;
}

/**
 * 在一条输入正文里找命中的路由前缀。
 *
 * 规则（顺序即优先级）：
 * 1. 去掉正文开头的空白；
 * 2. 按 prefix 长度降序（同一长度按配置顺序）做大小写不敏感的最左匹配；
 * 3. 前缀之后必须是输入结束，或一个非字母非数字字符（Unicode \p{L}\p{N}）——这样「开发文档」
 *    不会命中「开发」，而「开发：做一个登录页」会；
 * 4. 命中后去掉前缀及其后连续的空白与标点（\s 与 \p{P}），再 trim，作为派活的目标。
 *
 * 返回 {prefix,target,content}，无命中返回 null。
 */
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
