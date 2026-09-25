/**
 * 「文档」页的数据源：随这份代码发布的 `docs/` 下全部 Markdown 与根 `README.md`。
 * Markdown 是唯一文档源；流程图也写在 Mermaid fenced block 里，由浏览器按需渲染。
 *
 * 为什么按 id 查表、而不是按请求路径取文件：请求里的字符串永远不会被拼进文件系统路径，
 * 目录穿越、符号链接与任意文件读取在结构上就不可能发生——`readDoc` 只接受扫描结果里已有
 * 的 id。id 由相对路径推出（小写、`/` → `-`、去掉 `.md`），扫描时撞名就追加序号。
 *
 * 索引每次请求都重扫：文档是开发者正在改的文件，改完刷新页面就该看到新的，不该有缓存。
 * 代价是每个请求读一遍 docs/（几十 KB），对本地工具可以忽略。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：本文件在 src/ui/web/ 下，向上三级。 */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MAX_DEPTH = 4;
const MAX_BYTES = 2 * 1024 * 1024;

/** 目录前缀 → 分组标题。没登记的目录按自己的路径归类，新开文档目录不必先改这里。 */
const GROUPS = [
  ['docs/engineering', '架构'],
  ['docs/reference', '接口参考'],
  ['docs/contributing', '贡献指南'],
  ['docs/deployment', '部署'],
  ['docs', '总览'],
  ['', '总览'],
];
/** 索引页的分组顺序；没登记的分组排在后面，彼此按名字排。 */
const GROUP_ORDER = ['总览', '部署', '架构', '接口参考', '贡献指南'];

/** 少数入口的正文标题是项目名或太笼统，目录条目给一个更直白的名字。 */
const TITLE_OVERRIDES = {
  'README.md': '使用说明（README）',
  'docs/README.md': '文档索引',
  'docs/core-architecture.md': 'Lush 核心架构',
};

const toPosix = value => value.split(path.sep).join('/');
const dirOf = relative => (relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '');

function docId(relative) {
  const slug = relative.replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'doc';
}

function titleOf(markdown, relative) {
  const override = TITLE_OVERRIDES[relative];
  if (override) return override;
  const heading = /^ {0,3}#\s+(.+?)\s*#*\s*$/m.exec(markdown);
  return heading ? heading[1] : path.basename(relative, path.extname(relative));
}

function groupOf(relative) {
  const dir = dirOf(relative);
  for (const [prefix, label] of GROUPS) {
    if (prefix === '' || dir === prefix || dir.startsWith(`${prefix}/`)) return label;
  }
  return dir;
}

/** 只收普通 Markdown；`.isFile()` 对符号链接为 false。 */
function collect(dir, depth, out) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith('.')) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { collect(file, depth + 1, out); continue; }
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue;
    out.push(file);
  }
}

/** 全部文档的索引：`[{ id, title, group, path }]`，按分组顺序、组内按 id 排序。 */
export function docsIndex() {
  const files = [];
  const readme = path.join(ROOT, 'README.md');
  if (fs.existsSync(readme)) files.push(readme);
  const dir = path.join(ROOT, 'docs');
  if (fs.existsSync(dir)) collect(dir, 1, files);
  const used = new Set();
  const entries = [];
  for (const file of files) {
    let markdown;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_BYTES) continue;
      markdown = fs.readFileSync(file, 'utf8');
    } catch { continue; }   // 扫描与读取之间文件被删/改权限：跳过这一篇，不让整个索引失败
    const relative = toPosix(path.relative(ROOT, file));
    const base = docId(relative);
    let id = base, suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);
    entries.push({ id, title: titleOf(markdown, relative), group: groupOf(relative), path: relative, format: 'markdown' });
  }
  const rank = new Map(GROUP_ORDER.map((name, index) => [name, index]));
  const weight = label => rank.get(label) ?? GROUP_ORDER.length;
  return entries.sort((a, b) => weight(a.group) - weight(b.group)
    || (a.group === b.group ? 0 : a.group.localeCompare(b.group))
    || (a.id < b.id ? -1 : 1));
}

function searchable(markdown) {
  const fields = { headings: [], body: [], code: [], diagram: [] };
  let fence = null;
  const clean = value => String(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/^[\s>#*+\-\d.)]+/, '')
    .replace(/[|*_~]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  for (const line of String(markdown).replace(/\r\n?/g, '\n').split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], diagram: marker[2].toLowerCase() === 'mermaid' };
      else if (marker[1][0] === fence.char && !marker[2]) fence = null;
      continue;
    }
    if (fence) { (fence.diagram ? fields.diagram : fields.code).push(line); continue; }
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) { const value = clean(heading[1]); if (value) fields.headings.push(value); continue; }
    const value = clean(line); if (value) fields.body.push(value);
  }
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.join('\n')]));
}

/** 浏览器按需拉取的轻量全文索引；保留普通代码，Mermaid 源码单列并由前端降低权重。 */
export function docsSearchIndex() {
  return docsIndex().map(entry => {
    let markdown = '';
    try { markdown = fs.readFileSync(path.join(ROOT, entry.path), 'utf8'); } catch { /* 扫描后消失：留空索引项 */ }
    return { ...entry, ...searchable(markdown) };
  });
}

/** 按索引读一篇正文；id 不在表里返回 null（路由据此回 404）。 */
export function readDoc(id) {
  const entry = docsIndex().find(row => row.id === id);
  if (!entry) return null;
  try {
    const body = fs.readFileSync(path.join(ROOT, entry.path), 'utf8');
    return { ...entry, markdown: body };
  }
  catch { return null; }
}
