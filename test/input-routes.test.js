import { test, expect } from 'bun:test';
import { DEFAULT_INPUT_ROUTES, ROUTE_TARGETS, normalizeInputRoutes, matchInputRoute } from '../src/core/input-routes.js';

// 纯模块：不改仓库、不读数据库，只测确定性的前缀匹配规则。
test('default route table matches prefixes with separator or end-of-input', () => {
  expect(ROUTE_TARGETS).toEqual(['worker', 'research']);
  expect(DEFAULT_INPUT_ROUTES).toEqual([{ prefix: '开发', target: 'worker' }, { prefix: '解释', target: 'research' }]);
  expect(matchInputRoute(DEFAULT_INPUT_ROUTES, '开发 做一个登录页'))
    .toEqual({ prefix: '开发', target: 'worker', content: '做一个登录页' });
  expect(matchInputRoute(DEFAULT_INPUT_ROUTES, '解释：调度器怎么工作'))
    .toEqual({ prefix: '解释', target: 'research', content: '调度器怎么工作' });
  // 开头空白先去掉；只有前缀也合法，目标正文是空串（交给对应角色自行处理）。
  expect(matchInputRoute(DEFAULT_INPUT_ROUTES, '   开发   做页面  '))
    .toEqual({ prefix: '开发', target: 'worker', content: '做页面' });
  expect(matchInputRoute(DEFAULT_INPUT_ROUTES, '开发')).toEqual({ prefix: '开发', target: 'worker', content: '' });
});

test('a prefix must end at input end or a non letter/digit, so verbs do not fire mid-word', () => {
  // 「开发文档」是常见词组，不是「开发」路由。
  expect(matchInputRoute(DEFAULT_INPUT_ROUTES, '开发文档要补')).toBeNull();
  expect(matchInputRoute(DEFAULT_INPUT_ROUTES, '解释器怎么实现')).toBeNull();
  expect(matchInputRoute(DEFAULT_INPUT_ROUTES, '开发A')).toBeNull();
  expect(matchInputRoute(DEFAULT_INPUT_ROUTES, '做一个登录页')).toBeNull();
  expect(matchInputRoute(DEFAULT_INPUT_ROUTES, '')).toBeNull();
  expect(matchInputRoute(DEFAULT_INPUT_ROUTES, '   ')).toBeNull();
  expect(matchInputRoute(DEFAULT_INPUT_ROUTES, null)).toBeNull();
});

test('longest prefix wins and matching is case-insensitive', () => {
  const routes = [{ prefix: 'C', target: 'worker' }, { prefix: 'C++', target: 'research' }];
  expect(matchInputRoute(routes, 'C++ 做一个编译器')).toEqual({ prefix: 'C++', target: 'research', content: '做一个编译器' });
  expect(matchInputRoute(routes, 'c + 加一')).toEqual({ prefix: 'C', target: 'worker', content: '+ 加一' });

  const ascii = [{ prefix: 'Build', target: 'worker' }];
  expect(matchInputRoute(ascii, 'build: 页面')).toEqual({ prefix: 'Build', target: 'worker', content: '页面' });
  expect(matchInputRoute(ascii, 'BUILD 页面')).toEqual({ prefix: 'Build', target: 'worker', content: '页面' });
});

test('normalizeInputRoutes validates the shape and returns a fresh copy', () => {
  const input = [{ prefix: 'Build', target: 'worker' }];
  const normalized = normalizeInputRoutes(input);
  expect(normalized).toEqual(input);
  expect(normalized).not.toBe(input);
  expect(normalized[0]).not.toBe(input[0]);

  expect(normalizeInputRoutes([])).toEqual([]);
  const many = Array.from({ length: 32 }, (_, index) => ({ prefix: `p${index}`, target: 'worker' }));
  expect(normalizeInputRoutes(many)).toHaveLength(32);
});

test('normalizeInputRoutes rejects malformed tables', () => {
  const invalid = [
    'nope',
    Array.from({ length: 33 }, (_, index) => ({ prefix: `p${index}`, target: 'worker' })),
    [{ prefix: 'x', target: 'nope' }],
    [{ prefix: 'Dup', target: 'worker' }, { prefix: 'dup', target: 'research' }],
    [{ prefix: '', target: 'worker' }],
    [{ prefix: 'a b', target: 'worker' }],
    [{ prefix: 'x'.repeat(33), target: 'worker' }],
    [{ prefix: 'x' }],
    [{ prefix: 'x', target: 'worker', extra: 1 }],
    [null],
  ];
  for (const value of invalid) expect(() => normalizeInputRoutes(value)).toThrow();
});
