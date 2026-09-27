import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

// 「文档」视图在真 DOM 上的行为：左栏入口进目录、点条目读正文、站内相对链接接回同一路由，
// 以及打开期间轮询不覆盖它。每个 DOM 测试文件都自给自足：自己建 world、装 stub，再显式装配一次当前 DOM。
const DOCS = [
  { id: 'readme', title: '使用说明（README）', group: '总览', path: 'README.md' },
  { id: 'docs-engineering-modules', title: '模块地图（并行开发的边界）', group: '架构', path: 'docs/engineering/modules.md' },
  { id: 'docs-engineering-data-flow', title: '数据流', group: '架构', path: 'docs/engineering/data-flow.md' },
];
const BODY = {
  readme: '# Lush\n\n先读 [任务流程](docs/task-flow.md)，架构见 [模块地图](docs/engineering/modules.md)。\n\n| 项 | 值 |\n| --- | --- |\n| 依赖 | 零第三方 |\n',
  'docs-engineering-modules': '# 模块地图\n\n## 三条规矩\n\n[数据流](data-flow.md) 与 [外链](https://example.com/x)。\n',
  'docs-engineering-data-flow': '# 数据流\n\n入口到 Project 的结构。\n',
};

const world = makeWorld();
const baseFetch = world.fetchImpl;
const fetchImpl = async (url, options = {}) => {
  const path = String(url);
  const json = data => ({ ok: true, status: 200, json: async () => data });
  if (path === '/api/docs') return json({ docs: DOCS });
  if (path === '/api/docs/search-index') return json({ docs: DOCS.map(entry => ({ ...entry,
    headings: entry.id === 'docs-engineering-data-flow' ? 'Project 入口' : '',
    body: BODY[entry.id], code: '', diagram: '' })) });
  const match = /^\/api\/docs\/([a-z0-9._-]+)$/.exec(path);
  if (match) {
    const entry = DOCS.find(row => row.id === match[1]);
    if (!entry) return { ok: false, status: 404, json: async () => ({ error: `no such document: ${match[1]}` }) };
    return json({ ...entry, markdown: BODY[entry.id] });
  }
  return baseFetch(url, options);
};
const dom = installDom({ fetch: fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { openDocs } = await import('../../src/ui/web/assets/docs.js');
// app.js 顶部那次 boot() 只有本进程第一个 dom 文件会命中；这里先清掉左栏（导航是追加式装配），
// 再对着本文件的 stub 显式装配一次。
dom.node('side-nav').replaceChildren();
await boot();

afterAll(() => dom.restore());

const buttons = () => dom.node('detail').querySelectorAll('button');
const clickButton = async text => {
  const node = buttons().find(candidate => candidate.textContent === text);
  if (!node) throw new Error(`no button labelled ${text}`);
  await node.onclick();
};

test('文档视图：左栏入口进目录，点条目读正文，相对链接接回同一路由', async () => {
  // 左栏 workspace-nav 的第三个入口把地址栏切到 #docs，并渲染目录。
  expect(dom.node('docs-open')).toBeTruthy();
  dom.node('docs-open').onclick();
  expect(dom.location.hash).toBe('#docs');
  await openDocs();
  expect(dom.node('detail').dataset.view).toBe('docs');
  const index = deepText(dom.node('detail'));
  expect(index).toContain('文档');
  expect(index).toContain('总览');
  expect(index).toContain('架构');
  expect(index).toContain('使用说明（README）');
  expect(index).toContain('docs/engineering/modules.md');

  // 搜索索引第一次输入时才加载；中文/英文正文命中后只显示结果，清空恢复目录。
  const search = dom.node('detail').querySelector('input');
  expect(search.placeholder).toContain('搜索');
  search.value = 'Project 入口';
  search.listeners.input[0]();
  await Bun.sleep(5);
  expect(deepText(dom.node('detail'))).toContain('找到 1 篇相关文档');
  expect(deepText(dom.node('detail'))).toContain('数据流');
  search.value = '';
  search.listeners.input[0]();
  await Promise.resolve();
  expect(deepText(dom.node('detail'))).toContain('使用说明（README）');

  await clickButton('模块地图（并行开发的边界）');
  expect(dom.location.hash).toBe('#doc-docs-engineering-modules');
  expect(deepText(dom.node('detail'))).toContain('模块地图');
  // 正文的首个一级标题与页面标题重复，只留一个
  expect(dom.node('detail').querySelectorAll('h1')).toHaveLength(0);
  expect(dom.node('detail').querySelectorAll('h2').length).toBeGreaterThan(0);
  const links = dom.node('detail').querySelectorAll('a');
  // stub 的容器不聚合 textContent，比较链接文字要拼子树
  const inner = links.find(node => deepText(node).trim() === '数据流');
  // 相对链接被解析成站内 hash，并且不另开标签页
  expect(inner.getAttribute('href')).toBe('#doc-docs-engineering-data-flow');
  expect(inner.getAttribute('target')).toBeNull();
  const outer = links.find(node => deepText(node).trim() === '外链');
  expect(outer.getAttribute('href')).toBe('https://example.com/x');
  expect(outer.getAttribute('target')).toBe('_blank');

  // 后退/前进（真正的 hashchange）落到同一套路由上
  dom.location.hash = '#doc-docs-engineering-data-flow';
  await dom.fire('hashchange');
  expect(deepText(dom.node('detail'))).toContain('入口到 Project 的结构');
  expect(dom.location.hash).toBe('#doc-docs-engineering-data-flow');

  // 表格与 Markdown 排版：架构文档大量用表格，不能退化成一行竖线
  await clickButton('← 文档目录');
  await clickButton('使用说明（README）');
  expect(dom.node('detail').querySelectorAll('td').map(node => deepText(node).trim())).toEqual(['依赖', '零第三方']);
  expect(dom.node('detail').querySelectorAll('th').map(node => deepText(node).trim())).toEqual(['项', '值']);
});

test('文档视图打开时轮询不覆盖它，切到别的视图后让位', async () => {
  await openDocs('docs-engineering-modules');
  // 轮询一次：右栏必须还是文档，而不是被 renderOverview 顶掉
  await dom.intervalFor(1500)();
  expect(deepText(dom.node('detail'))).toContain('模块地图');
  expect(deepText(dom.node('detail'))).not.toContain('项目概览');

  // 点 Lush 标志回概览：右栏换回概览，文档标志让位
  await dom.node('home').onclick();
  expect(deepText(dom.node('detail'))).toContain('项目概览');
  expect(dom.node('detail').dataset.view).toBe('overview');

  // 从文档视图点进任务详情：右栏归任务，随后轮询也不会把文档画回来
  await openDocs('docs-engineering-modules');
  dom.location.hash = '#task-1';
  await dom.fire('hashchange');
  expect(dom.node('detail').dataset.view).toBe('task');
  await dom.intervalFor(1500)();
  expect(deepText(dom.node('detail'))).not.toContain('三条规矩');
});

test('文档视图：未知 id 给出错误与退路，不抛到页面上', async () => {
  dom.location.hash = '#doc-nope';
  await dom.fire('hashchange');
  expect(deepText(dom.node('detail'))).toContain('打开失败');
  expect(dom.node('error').textContent).toBe('');
  await clickButton('← 文档目录');
  expect(dom.location.hash).toBe('#docs');
  expect(deepText(dom.node('detail'))).toContain('总览');
});
