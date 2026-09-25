/**
 * 浏览器侧的快速路由前缀**表**：只给设置页的旧提交路径编辑器提供目标取值与默认前缀。
 *
 * 这里不再带匹配实现：新 say 不走快速路由，输入框也不再高亮前缀，所以浏览器侧不需要第二份匹配逻辑。
 * 真正的前缀匹配只在 core（`src/core/input-routes.js`），供旧客户端提交使用。
 */

export const ROUTE_TARGETS = ['worker', 'research'];

/** 与 core 相同的默认前缀表，供没有运行设置快照时回退展示。 */
export const DEFAULT_INPUT_ROUTES = [
  { prefix: '开发', target: 'worker' },
  { prefix: '解释', target: 'research' },
];
