/**
 * 「文档」页的渲染：目录页、单篇正文、打不开时的兜底。
 *
 * 纯渲染：取数、路由与相对链接解析在 docs.js，这里只把拿到的数据画进 #detail。
 * 正文一律按 Markdown 渲染，不跟界面设置里的「Markdown 渲染」偏好走：那个偏好管的是 agent 输出，
 * 而文档本来就是 Markdown 写的，关掉只会让表格、代码块和标题退化成一片原文。
 */
import { $, block, button, el } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { clearMermaidDiagrams, refreshMermaidDiagrams, renderMermaidDiagrams } from './mermaid-docs.js';
import { searchDocs } from './docs-search.js';

const pathHint = value => el('span', value, 'when mono');
const themeDocuments = new WeakSet();

function watchDocumentTheme(doc) {
  if (themeDocuments.has(doc)) return;
  themeDocuments.add(doc);
  doc.documentElement?.addEventListener?.('lush-themechange', () => {
    const body = doc.querySelector?.('.doc-body');
    if (body) void refreshMermaidDiagrams(body);
  });
}

function docsHead(title, onOpen) {
  const head = el('div', undefined, 'head');
  head.append(el('span', title, 'tid-lg'), button('← 文档目录', () => onOpen(null), 'link doc-back'));
  return head;
}

/** 目录页：按分组列出全部文档；第一次输入查询时才拉全文索引。 */
export function renderDocsIndex(docs, onOpen, options = {}) {
  const panel = $('detail');
  panel.dataset.view = 'docs';   // 左栏高亮与进场动画都跟着这个属性走，和 graph / task 同一套
  clearMermaidDiagrams(panel);
  panel.replaceChildren();
  panel.scrollTop = 0;
  const head = el('div', undefined, 'head');
  head.append(el('span', '帮助文档', 'tid-lg'));
  panel.append(head, el('p', '这些是随当前代码发布的文档：先看总体架构与使用说明，再按需查任务流程与接口参考。文档之间的相对链接可以直接点开。', 'hint'));

  const search = el('div', undefined, 'doc-search');
  const input = el('input');
  input.type = 'search'; input.placeholder = '搜索标题、正文、命令或源码路径…'; input.value = options.query || '';
  input.setAttribute('aria-label', '搜索文档内容');
  const status = el('span', '输入关键字搜索全部文档', 'hint doc-search-status');
  const results = el('div', undefined, 'doc-search-results'); results.hidden = true;
  search.append(input, status); panel.append(search, results);

  const catalog = el('div', undefined, 'doc-catalog');
  const groups = [];
  for (const doc of docs) {
    let bucket = groups.find(entry => entry.name === doc.group);
    if (!bucket) { bucket = { name: doc.group, items: [] }; groups.push(bucket); }
    bucket.items.push(doc);
  }
  for (const group of groups) {
    const section = block(group.name, String(group.items.length));
    for (const doc of group.items) {
      const row = el('div', undefined, 'row doc-row');
      row.append(button(doc.title, () => onOpen(doc.id), 'link'), pathHint(doc.path));
      section.append(row);
    }
    catalog.append(section);
  }
  catalog.append(el('p', `共 ${docs.length} 篇。内容来自仓库的 docs/ 与 README.md，改完文件刷新页面即可看到。`, 'hint doc-foot'));
  panel.append(catalog);

  let revision = 0, first = null;
  const run = async () => {
    const query = input.value.trim(), current = ++revision;
    options.onQuery?.(query);
    if (!query) {
      catalog.hidden = false; results.hidden = true; results.replaceChildren(); first = null;
      status.textContent = '输入关键字搜索全部文档'; return;
    }
    catalog.hidden = true; results.hidden = false; results.replaceChildren(); first = null;
    status.textContent = '正在建立搜索索引…';
    try {
      const index = await options.loadSearch();
      if (current !== revision) return;
      const matches = searchDocs(index, query);
      status.textContent = matches.length ? `找到 ${matches.length} 篇相关文档` : '没有找到相关文档';
      for (const match of matches) {
        const row = el('article', undefined, 'doc-search-result');
        const open = button(match.title, () => onOpen(match.id), 'link');
        if (!first) first = open;
        const meta = el('div', undefined, 'doc-search-meta');
        meta.append(el('span', match.group, 'badge b-neutral'), pathHint(match.path));
        row.append(open, meta);
        if (match.snippet) row.append(el('p', match.snippet, 'doc-search-snippet'));
        results.append(row);
      }
    } catch (error) {
      if (current !== revision) return;
      status.textContent = `搜索索引加载失败：${error.message}`;
    }
  };
  input.addEventListener('input', () => { void run(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') { input.value = ''; void run(); }
    else if (event.key === 'Enter' && first) { event.preventDefault(); first.click(); }
  });
  if (input.value) void run();
}

/** 单篇正文：标题 + 仓库内路径 + 正文；resolveLink 由 docs.js 提供，用来把站内相对链接接回路由。 */
export function renderDoc(doc, resolveLink, onOpen) {
  const panel = $('detail');
  panel.dataset.view = 'docs';
  clearMermaidDiagrams(panel);
  panel.replaceChildren();
  panel.scrollTop = 0;
  panel.append(docsHead(doc.title, onOpen), el('p', doc.path, 'hint mono'));
  watchDocumentTheme(document);
  const body = renderMarkdown(doc.markdown, document, { link: resolveLink, diagrams: true });
  body.classList.add('doc-body');
  // 每篇都以 `# 标题` 开头，而页面头部已经写了同一个标题：去掉正文的第一个一级标题，
  // 不然同一行要读两遍。用 children[0] 而不是 firstElementChild，测试的 DOM stub 也认。
  const first = body.children[0];
  if (first && first.tagName === 'H1') first.remove();
  panel.append(body);
  // Mermaid 体积较大，只在正文真的有图时按需加载；失败会由模块原地回退成源码。
  void renderMermaidDiagrams(body);
}

/** 打不开时的兜底：给出去处，不把用户堵在一个空白右栏里。 */
export function renderDocError(id, message, onOpen) {
  const panel = $('detail');
  panel.dataset.view = 'docs';
  clearMermaidDiagrams(panel);
  panel.replaceChildren();
  panel.scrollTop = 0;
  panel.append(docsHead(id ? `文档 ${id}` : '文档', onOpen), el('p', `打开失败：${message}`, 'hint error'));
}
