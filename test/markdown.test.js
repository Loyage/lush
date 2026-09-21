import { test, expect } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import { fixture } from './helpers.js';
import { RPCServer } from '../src/rpc/server.js';
import { Dispatcher } from '../src/rpc/protocol.js';
import { createSignal } from '../src/signal.js';
import { startWeb } from '../src/ui/web/server.js';
import { renderMarkdown, parseMarkdown, safeUrl, MAX_MARKDOWN_LENGTH } from '../src/ui/web/assets/markdown.js';

/* ---------------- 一个最小的 document 替身：只实现 markdown.js 用到的 API ---------------- */
class FakeText {
  constructor(text) { this.nodeType = 3; this._text = String(text); }
  get textContent() { return this._text; }
}
class FakeElement {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.childNodes = []; this.attributes = {}; }
  get className() { return this.attributes.class || ''; }
  set className(value) { this.attributes.class = String(value); }
  append(...nodes) { for (const node of nodes) { if (node === null || node === undefined || node === false) continue; this.childNodes.push(node instanceof FakeElement || node instanceof FakeText ? node : new FakeText(node)); } }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return Object.hasOwn(this.attributes, key) ? this.attributes[key] : null; }
  set textContent(value) { this.childNodes = [new FakeText(value)]; }
  get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
}
const doc = { createElement: tag => new FakeElement(tag), createTextNode: text => new FakeText(text) };
const docHtml = node => {
  if (node instanceof FakeText) return node._text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const attrs = Object.entries(node.attributes).map(([key, value]) => ` ${key}="${value}"`).join('');
  const tag = node.tagName.toLowerCase();
  if (tag === 'br' || tag === 'hr') return `<${tag}${attrs}>`;
  return `<${tag}${attrs}>${node.childNodes.map(docHtml).join('')}</${tag}>`;
};
const html = (markdown, options) => docHtml(renderMarkdown(markdown, doc, options));
const find = (node, tag) => {
  if (node instanceof FakeElement && node.tagName === tag.toUpperCase()) return node;
  if (node instanceof FakeElement) for (const child of node.childNodes) { const hit = find(child, tag); if (hit) return hit; }
  return null;
};
const findAll = (node, tag, out = []) => {
  if (node instanceof FakeElement) { if (node.tagName === tag.toUpperCase()) out.push(node); for (const child of node.childNodes) findAll(child, tag, out); }
  return out;
};

/* ---------------- 解析 / 渲染 ---------------- */
test('markdown escapes HTML and never emits raw script/attribute payloads', () => {
  const source = '<script>alert("x")</script> & "quotes" \'single\'';
  const out = html(source);
  expect(out).not.toContain('<script>');
  expect(out).not.toContain('</script>');
  expect(out).toContain('&lt;script&gt;');
  expect(out).toContain('&amp;');
  expect(out).toContain('&quot;');
  expect(renderMarkdown(source, doc).textContent).toBe(source);
});

test('markdown renders headings, lists, quotes, rules and inline code', () => {
  expect(html('# 标题')).toContain('<h1>标题</h1>');
  expect(html('### 小标题')).toContain('<h3>小标题</h3>');
  expect(html('- 甲\n- 乙')).toContain('<ul><li>甲</li><li>乙</li></ul>');
  expect(html('1. 甲\n2. 乙')).toContain('<ol><li>甲</li><li>乙</li></ol>');
  expect(html('> 引用')).toContain('<blockquote><p>引用</p></blockquote>');
  expect(html('---')).toContain('<hr>');
  expect(html('这是 `a < b & c` 代码')).toContain('<code>a &lt; b &amp; c</code>');
  expect(html('**粗** 和 *斜*')).toContain('<strong>粗</strong>');
  expect(html('**粗** 和 *斜*')).toContain('<em>斜</em>');
  expect(html('第一行\n第二行')).toContain('<br>');
});

test('GFM 表格：对齐行决定表格，单元格里的行内语法照常生效', () => {
  const out = html('| 项 | 值 |\n| --- | :---: |\n| 依赖 | 零**第三方** |\n| 入口 | `src/a.js` |');
  expect(out).toContain('<table>');
  expect(out).toContain('<th>项</th>');
  expect(out).toContain('<td>依赖</td>');
  expect(out).toContain('<strong>第三方</strong>');
  expect(out).toContain('<th style="text-align:center">值</th>');
  expect(out).toContain('<code>src/a.js</code>');
  // 只是「一行文本里带竖线」不构成表格，必须紧跟对齐行
  expect(html('a | b\nc | d')).not.toContain('<table>');
  expect(html('| 只有表头 |\nnope')).not.toContain('<table>');
  // 列数不一致时退回普通段落，不把上面的正文吞成表格
  expect(html('a | b\n| --- |\n| 1 |')).not.toContain('<table>');
});

test('调用方可以接管链接解析（文档页用它把相对路径接回站内路由）', () => {
  const link = raw => (raw.endsWith('.md') ? { href: `#doc-${raw}`, external: false } : null);
  const out = html('[下一篇](next.md) 与 [外链](https://example.com/x) 与 [源码](src/a.js)', { link });
  // 站内链接：换成自己的 href，不另开标签页
  expect(out).toContain('<a href="#doc-next.md">下一篇</a>');
  // 解析器没接管的仍然按默认规则走：http/https 外开，其余降级成纯文本
  expect(out).toContain('<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">外链</a>');
  expect(out).toContain('源码 (src/a.js)');
  expect(out).not.toContain('href="src/a.js"');
  // 解析器里抛错只影响那一条链接：正文照旧是 Markdown，不整篇回退成纯文本
  const broken = html('[甲](a.md)', { link: () => { throw new Error('bad'); } });
  expect(broken).toContain('<div class="markdown">');
  expect(broken).not.toContain('md-plain');
  expect(broken).toContain('甲 (a.md)');
});

test('fenced code keeps newlines and shows a language label', () => {
  const out = html('```js\nconst a = 1;\nconsole.log("<x>");\n```');
  expect(out).toContain('class="md-lang"');
  expect(out).toContain('>js<');
  expect(out).toContain('<pre><code class="language-js">');
  expect(find(renderMarkdown('```js\nconst a = 1;\n```', doc), 'code').textContent).toBe('const a = 1;');
  // 未闭合围栏不抛错，内容不被吞掉
  expect(() => html('```js\nconst a = 1;')).not.toThrow();
  expect(html('~~~\nplain\n~~~')).toContain('plain');
});

test('links only allow http/https with safe rel/target', () => {
  const out = html('[示例](https://example.com/a?b=1)');
  expect(out).toContain('<a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer">示例</a>');
  const bad = html('[点我](javascript:alert(1))');
  expect(bad).not.toContain('<a ');
  expect(renderMarkdown('[点我](javascript:alert(1))', doc).textContent).toBe('点我 (javascript:alert(1))');
  expect(html('[数据](data:text/html;base64,PHNjcmlwdD4=)')).not.toContain('<a ');
  expect(html('[相对](/etc/passwd)')).not.toContain('<a ');
  expect(safeUrl('https://example.com')).toBe('https://example.com/');
  expect(safeUrl('HTTP://example.com')).toBe('http://example.com/');
  expect(safeUrl(' javascript:x ')).toBeNull();
  expect(safeUrl('')).toBeNull();
});

test('plain, empty and malformed input fall back without throwing', () => {
  expect(() => renderMarkdown('', doc)).not.toThrow();
  expect(() => renderMarkdown(null, doc)).not.toThrow();
  expect(() => renderMarkdown('普通文本\n第二行', doc)).not.toThrow();
  expect(renderMarkdown('普通文本', doc).textContent).toBe('普通文本');
  expect(renderMarkdown('', doc).childNodes).toHaveLength(0);
  expect(() => html('# \n> \n- \n```\n')).not.toThrow();
  expect(renderMarkdown('*未闭合 **粗体', doc).textContent).toBe('*未闭合 **粗体');
  expect(parseMarkdown('a\n\n\nb').length).toBe(2);
});

test('over-long text falls back to plain text with the original content', () => {
  const long = 'x'.repeat(MAX_MARKDOWN_LENGTH + 1);
  const node = renderMarkdown(long, doc);
  expect(node.getAttribute('data-fallback')).toBe('too-long');
  expect(node.className).toContain('md-plain');
  expect(find(node, 'pre').textContent).toBe(long);
  expect(find(node, 'pre').textContent.length).toBe(long.length);
});

/* ---------------- Web 静态资源 ---------------- */
const fetch = (url, options = {}) => new Promise((resolve, reject) => {
  const request = http.request(url, { method: options.method || 'GET', headers: options.headers }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
  });
  request.on('error', reject); request.end(options.body);
});
async function setup() {
  const f = fixture(), signal = createSignal();
  const rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, signal, {})); await rpc.start();
  const web = startWeb(f.config, 0);
  return { ...f, rpc, web, url: `http://127.0.0.1:${web.port}`, async close() {
    web.stop(true); await rpc.close(); await f.close(); fs.rmSync(f.config.socket, { force: true });
  } };
}

test('web serves the markdown module and keeps the CSP header', async () => {
  const f = await setup();
  try {
    const module = await fetch(`${f.url}/markdown.js`);
    expect(module.status).toBe(200);
    expect(module.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await module.text()).toContain('export function renderMarkdown');
    // app.js 只是入口：markdown.js 由真正 import 它的 text.js（agent 输出渲染）加载。
    const loader = await fetch(`${f.url}/text.js`);
    expect(loader.status).toBe(200);
    expect(await loader.text()).toContain("from './markdown.js'");
    const page = await (await fetch(f.url)).text();
    expect(page).not.toContain('md-toggle');
    expect(page).not.toContain('Markdown 渲染：开');
    // 开关未开启前后端仍拒绝未知路径
    expect((await fetch(`${f.url}/other.js`)).status).toBe(404);
  } finally { await f.close(); }
});
