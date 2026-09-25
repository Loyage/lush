import { test, expect } from 'bun:test';
import path from 'node:path';
import { fetch, setup } from './harness.js';

// 「文档」页的数据源：随这份代码发布的 docs/ 与根 README.md，与当前项目目录无关。
// 路由只按扫出来的 id 查表，请求里的路径片段永远不进文件系统。

test('docs index lists the bundled documentation, grouped for reading', async () => {
  const f = await setup();
  try {
    const { docs } = await (await fetch(f.url + '/api/docs')).json();
    const ids = docs.map(doc => doc.id);
    expect(ids).toContain('readme');
    expect(ids).toContain('docs-task-flow');
    expect(ids).toContain('docs-engineering-modules');
    expect(docs.find(doc => doc.id === 'readme').group).toBe('总览');
    expect(docs.find(doc => doc.id === 'docs-contributing-documentation').group).toBe('贡献指南');
    const modules = docs.find(doc => doc.id === 'docs-engineering-modules');
    expect(modules.group).toBe('架构');
    expect(modules.path).toBe('docs/engineering/modules.md');
    expect(modules.title).toContain('模块地图');
    // 分组顺序读起来是「总览 → 架构 → 接口参考」
    expect(ids.indexOf('docs-engineering-modules')).toBeLessThan(ids.indexOf('docs-reference-api'));
    // 组内按 id 稳定排序：同一组里连续排在一起的 id 严格递增
    const runs = new Map();
    for (const doc of docs) runs.set(doc.group, [...(runs.get(doc.group) || []), doc.id]);
    for (const group of runs.values()) expect([...group].sort()).toEqual(group);
    // fixture 项目目录里没有 docs/：有内容就证明文档读的是发布出去的那份，不是项目里的
    expect(docs.length).toBeGreaterThan(5);
  } finally { await f.close(); }
});

test('each document is delivered as markdown with its repository path', async () => {
  const f = await setup();
  try {
    const readme = await (await fetch(f.url + '/api/docs/readme')).json();
    expect(readme.path).toBe('README.md');
    expect(readme.markdown).toStartWith('# Lush');
    expect(readme.markdown).toContain('docs/task-flow.md');
    const modules = await (await fetch(f.url + '/api/docs/docs-engineering-modules')).json();
    expect(modules.markdown).toContain('模块地图');
    expect(modules.markdown).toContain('src/core/project.js');
    // 子目录里的文档同样只靠 id 命中
    const rpc = await (await fetch(f.url + '/api/docs/docs-reference-rpc-tasks')).json();
    expect(rpc.path).toBe('docs/reference/rpc/tasks.md');
  } finally { await f.close(); }
});

test('the lazy search index contains headings, prose and code without mixing Mermaid into prose', async () => {
  const f = await setup();
  try {
    const response = await fetch(f.url + '/api/docs/search-index');
    expect(response.status).toBe(200);
    const { docs } = await response.json();
    const core = docs.find(doc => doc.id === 'docs-core-architecture');
    const execution = docs.find(doc => doc.id === 'docs-engineering-execution-model');
    expect(core.headings).toContain('项目、输入与任务');
    expect(core.body).toContain('直接关联的 Task');
    expect(execution.body).toContain('Plan Compiler');
    expect(core.diagram).toContain('flowchart LR');
    expect(core.body).not.toContain('flowchart LR');
  } finally { await f.close(); }
});

test('docs routes only reach the bundled markdown files', async () => {
  const f = await setup();
  try {
    // 形状合法但查不到的 id：明确告诉调用方「没有这篇」
    for (const route of ['/api/docs/nope', '/api/docs/docs', '/api/docs/readme.md', '/api/docs/package-json', '/api/docs/src-ui-web-docs']) {
      const response = await fetch(f.url + route);
      expect(response.status).toBe(404);
      expect((await response.json()).error).toContain('no such document');
    }
    // 带穿越片段/子路径的请求连路由都不匹配，落在统一的 404 上，不会被当成文件名
    for (const route of ['/api/docs/%2e%2e%2fserver.js', '/api/docs/..%2f..%2fetc%2fpasswd', '/api/docs/docs/engineering/modules.md']) {
      expect((await fetch(f.url + route)).status).toBe(404);
    }
  } finally { await f.close(); }
});

test('the docs page modules are served as assets and wired into the app entry', async () => {
  const f = await setup();
  try {
    for (const file of ['/docs.js', '/docs-search.js', '/render-docs.js', '/mermaid-docs.js', '/mermaid.min.js']) {
      const response = await fetch(f.url + file);
      expect(response.status).toBe(200);
      const body = await response.text();
      if (file !== '/mermaid.min.js') expect(body).toContain('export ');
      else {
        expect(body.length).toBeGreaterThan(1_000_000);
        expect(body).toContain('globalThis["mermaid"]');
      }
    }
    const html = await (await fetch(f.url)).text();
    // 入口在左栏 workspace-nav，与「项目概览 / 分支图」并列
    expect(html).toContain('id="docs-open"');
    expect(html).toContain('文档');
  } finally { await f.close(); }
});

test('the docs module resolves only bundled Markdown', async () => {
  const { docsIndex, readDoc } = await import('../../src/ui/web/docs.js');
  const index = docsIndex();
  // 索引里每一项都必须真的是仓库内的 .md，且 id 唯一
  const ids = new Set();
  for (const doc of index) {
    expect(doc.path).toMatch(/^(README\.md|docs\/.*\.md)$/);
    expect(doc.format).toBe('markdown');
    expect(path.isAbsolute(doc.path)).toBe(false);
    expect(doc.path).not.toContain('..');
    expect(ids.has(doc.id)).toBe(false);
    ids.add(doc.id);
  }
  expect(readDoc('readme').markdown).toContain('# Lush');
  expect(readDoc('docs-core-architecture')).toMatchObject({ format: 'markdown' });
  expect(readDoc('docs-core-architecture').markdown).toContain('新 `say` 保存 Input');
  expect(readDoc('docs-core-architecture').markdown).toContain('```mermaid');
  // 任何不在索引里的字符串都读不出东西——请求里的路径永远不会被拼进文件名
  for (const attempt of ['../package.json', 'docs/../package.json', 'package.json', '', 'README']) {
    expect(readDoc(attempt)).toBeNull();
  }
});
