import { test, expect } from 'bun:test';
import { matchInputRoute as coreMatch, ROUTE_TARGETS as coreTargets, DEFAULT_INPUT_ROUTES } from '../../src/core/input-routes.js';
import { matchInputRoute as webMatch, ROUTE_TARGETS as webTargets, DEFAULT_INPUT_ROUTES as webDefaults } from '../../src/ui/web/assets/input-routes.js';

// 前缀规则在 core 与浏览器各有一份实现（浏览器不能 import 服务端核心）。这份用例把两边绑在
// 一起：同一组 routes + 同一组正文必须给出完全一致的结果，任何一侧改了规则都会在这里失败。
const routes = [
  { prefix: '开发', target: 'worker' },
  { prefix: '解释', target: 'research' },
  { prefix: 'dev', target: 'worker' },
  { prefix: 'research', target: 'research' },
  { prefix: '开发文档', target: 'research' },
];

// 覆盖：空/非字符串、前导空白、长短前缀优先级、大小写、分隔符与标点剥离、Unicode 字母数字边界、
// 不命中、前缀后紧跟中英文导致不命中，以及 core 默认前缀表。
const inputs = [
  '', '   ', '开发', '开发 做一个登录页', '开发：做一个登录页', '开发，做一个登录页',
  '开发文档 写一篇说明', '开发文档', '开发abc', '开发123', '开发_a', '开发-a',
  '  开发   收尾', '解释 调度器怎么工作', '解释：为什么这样设计', '解释',
  'dev build the login page', 'DEV Build it', 'dev: build it', 'developer build it',
  'dev_1 build', 'research how the scheduler works', 'research', 'researching the scheduler',
  '  Research: deep dive', '随便写点什么', 'Development plan', '开 发',
  null, undefined, 42, '解释   、、 继续', '开发\t\n多行',
];

test('浏览器前缀匹配与 core 完全一致', () => {
  expect(webTargets).toEqual(coreTargets);
  expect(webDefaults).toEqual(DEFAULT_INPUT_ROUTES);
  for (const content of inputs) {
    expect(webMatch(routes, content)).toEqual(coreMatch(routes, content));
  }
});

test('浏览器前缀匹配与 core 对默认前缀表也一致', () => {
  const defaults = DEFAULT_INPUT_ROUTES;
  for (const content of inputs) {
    expect(webMatch(defaults, content)).toEqual(coreMatch(defaults, content));
  }
});

test('两边都不因未命中而抛错，命中结果结构一致', () => {
  const hitCore = coreMatch(routes, '开发：做一个登录页');
  const hitWeb = webMatch(routes, '开发：做一个登录页');
  expect(hitWeb).toEqual(hitCore);
  expect(hitWeb).toEqual({ prefix: '开发', target: 'worker', content: '做一个登录页' });
  expect(webMatch(routes, '')).toBe(null);
  expect(webMatch(routes, null)).toBe(null);
  expect(webMatch(routes, '开发文档 写一篇说明')).toEqual({ prefix: '开发文档', target: 'research', content: '写一篇说明' });
});
