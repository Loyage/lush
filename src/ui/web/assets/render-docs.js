/**
 * 「文档」页的渲染：目录页、单篇正文、打不开时的兜底。
 *
 * 纯渲染：取数、路由与相对链接解析在 docs.js，这里只把拿到的数据画进 #detail。
 * 正文一律按 Markdown 渲染，不跟界面设置里的「Markdown 渲染」偏好走：那个偏好管的是 agent 输出，
 * 而文档本来就是 Markdown 写的，关掉只会让表格、代码块和标题退化成一片原文。
 */
import { $, block, button, el } from './dom.js';
import { renderMarkdown } from './markdown.js';

const pathHint = value => el('span', value, 'when mono');

function docsHead(title, onOpen) {
  const head = el('div', undefined, 'head');
  head.append(el('span', title, 'tid-lg'), button('← 文档目录', () => onOpen(null), 'link doc-back'));
  return head;
}

/** 目录页：按分组列出全部文档，点标题进入正文（onOpen(id)）。 */
export function renderDocsIndex(docs, onOpen) {
  const panel = $('detail');
  panel.dataset.view = 'docs';   // 左栏高亮与进场动画都跟着这个属性走，和 graph / task 同一套
  panel.replaceChildren();
  panel.scrollTop = 0;
  const head = el('div', undefined, 'head');
  head.append(el('span', '文档', 'tid-lg'));
  panel.append(head, el('p', '这些是随当前代码发布的文档：先看总体架构与使用说明，再按需查任务流程与接口参考。文档之间的相对链接可以直接点开。', 'hint'));

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
    panel.append(section);
  }
  panel.append(el('p', `共 ${docs.length} 篇。内容来自仓库的 docs/ 与 README.md，改完文件刷新页面即可看到。`, 'hint doc-foot'));
}

/** 单篇正文：标题 + 仓库内路径 + 正文；resolveLink 由 docs.js 提供，用来把站内相对链接接回路由。 */
export function renderDoc(doc, resolveLink, onOpen) {
  const panel = $('detail');
  panel.dataset.view = 'docs';
  panel.replaceChildren();
  panel.scrollTop = 0;
  panel.append(docsHead(doc.title, onOpen), el('p', doc.path, 'hint mono'));
  if (doc.format === 'html') {
    const frame = el('iframe', undefined, 'doc-frame');
    frame.src = `/api/docs/${doc.id}/html`;
    frame.title = doc.title;
    frame.setAttribute('sandbox', '');
    panel.append(frame);
    return;
  }
  const body = renderMarkdown(doc.markdown, document, { link: resolveLink });
  body.classList.add('doc-body');
  // 每篇都以 `# 标题` 开头，而页面头部已经写了同一个标题：去掉正文的第一个一级标题，
  // 不然同一行要读两遍。用 children[0] 而不是 firstElementChild，测试的 DOM stub 也认。
  const first = body.children[0];
  if (first && first.tagName === 'H1') first.remove();
  panel.append(body);
}

/** 打不开时的兜底：给出去处，不把用户堵在一个空白右栏里。 */
export function renderDocError(id, message, onOpen) {
  const panel = $('detail');
  panel.dataset.view = 'docs';
  panel.replaceChildren();
  panel.scrollTop = 0;
  panel.append(docsHead(id ? `文档 ${id}` : '文档', onOpen), el('p', `打开失败：${message}`, 'hint error'));
}
