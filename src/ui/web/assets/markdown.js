// 极简 Markdown 渲染器：纯解析 + createElement/textContent 构建 DOM。
// 不使用 innerHTML，所有 Markdown 文本都经过 DOM 文本节点；文档视图可把 mermaid fence 标成
// 待渲染容器，再由 mermaid-docs.js 按需加载本地 Mermaid。Agent 输出默认仍显示普通代码块。
// 解析失败或输入异常时回退为纯文本 <pre>，绝不抛错。

export const MAX_MARKDOWN_LENGTH = 50000;

/** 只允许 http/https；其余（javascript:、data:、相对路径等）一律降级为纯文本。 */
export function safeUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.href;
}

/* ---------------- inline ---------------- */

const WORD = /[0-9A-Za-z]/;
const LINK = /^\[([^\]]*)\]\(\s*([^)\s]*)\s*\)/;
const CODE_SPAN = /^`([^`]+)`/;

function parseInline(text, options = {}) {
  const nodes = [];
  let buffer = '';
  const flush = () => { if (buffer) { nodes.push({ type: 'text', value: buffer }); buffer = ''; } };
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    // 反斜杠转义，避免把 \* 之类当语法
    if (char === '\\' && i + 1 < text.length && '\\`*_{}[]()#+-.!>~'.includes(text[i + 1])) {
      buffer += text[i + 1]; i += 2; continue;
    }
    if (char === '`') {
      const match = CODE_SPAN.exec(text.slice(i));
      if (match) { flush(); nodes.push({ type: 'code', value: match[1] }); i += match[0].length; continue; }
    }
    if (char === '[') {
      const match = LINK.exec(text.slice(i));
      if (match) { flush(); nodes.push(linkNode(match[1], match[2], options)); i += match[0].length; continue; }
    }
    if (char === '*' || char === '_') {
      const delim = text.startsWith(char.repeat(2), i) ? char.repeat(2) : char;
      const end = findClosing(text, char, delim.length, i + delim.length);
      if (end > i + delim.length) {
        const before = i > 0 ? text[i - 1] : '';
        const after = end + delim.length < text.length ? text[end + delim.length] : '';
        // 下划线强调不能出现在单词内部（snake_case 原样保留）
        if (char !== '_' || (!WORD.test(before) && !WORD.test(after))) {
          flush();
          nodes.push({ type: delim.length === 2 ? 'strong' : 'em', children: parseInline(text.slice(i + delim.length, end), options) });
          i = end + delim.length; continue;
        }
      }
    }
    if (char === '\n') { buffer = buffer.replace(/ {2,}$/, ''); flush(); nodes.push({ type: 'br' }); i++; continue; }
    buffer += char; i++;
  }
  flush();
  return nodes;
}

// 只认可整段长度相等的闭合符，避免把 ** 的一半当成 * 的结束。
function findClosing(text, char, length, from) {
  let i = from;
  while (i < text.length) {
    if (text[i] !== char) { i++; continue; }
    let run = 0;
    while (i + run < text.length && text[i + run] === char) run++;
    if (run === length) return i;
    i += run;
  }
  return -1;
}

/**
 * 链接的两条出口：调用方给的 `options.link(raw, label)` 优先（「文档」页用它把相对路径指回站内），
 * 解析不出来再退回 safeUrl——只有 http/https 能成链接，其余一律降级成纯文本。
 * `external` 决定要不要 `target="_blank"`：站内跳转不该另开标签页。
 */
function linkNode(label, raw, options) {
  // 解析器是调用方给的代码：它抛错只该让这一条链接退回默认规则，不该把整篇文档打成纯文本。
  let custom = null;
  try { custom = typeof options.link === 'function' ? options.link(raw, label) : null; }
  catch { custom = null; }
  if (custom && custom.href) {
    return { type: 'link', href: String(custom.href), external: custom.external === true, children: parseInline(label, options) };
  }
  const href = safeUrl(raw);
  if (!href) return { type: 'text', value: raw ? `${label} (${raw})` : label };
  return { type: 'link', href, external: true, children: parseInline(label, options) };
}

/* ---------------- blocks ---------------- */

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const UL = /^ {0,3}[-*+]\s+(.*)$/;
const OL = /^ {0,3}\d{1,9}[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;

const startsBlock = line => FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || UL.test(line) || OL.test(line);

/* ---------------- tables（GFM） ---------------- */
// 架构文档大量使用表格，没有它就只剩一堆竖线。识别只在「含 | 的行 + 紧跟一行对齐行」时生效，
// 普通文本里的 | 不受影响；行内语法（强调、代码、链接）照常在单元格里生效。

/** `| a | b |` → ['a','b']；两端竖线可省略。 */
function splitRow(line) {
  let text = String(line).trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);
  return text.split('|').map(cell => cell.trim());
}
const isTableRow = line => line.includes('|');
const isDelimiterRow = line => line.includes('-') && splitRow(line).every(cell => /^:?-+:?$/.test(cell));
function delimiterAlign(line) {
  return splitRow(line).map(cell => {
    const left = cell.startsWith(':'), right = cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
  });
}
// 表头与对齐行的列数必须一致：否则「上文里的 | + 下文的 ---」会被误当成表格。
function tableStart(lines, at, options) {
  const head = lines[at], delim = lines[at + 1];
  if (delim === undefined || !isTableRow(head) || !isDelimiterRow(delim)) return null;
  const cells = splitRow(head), align = delimiterAlign(delim);
  if (cells.length !== align.length) return null;
  const rows = [];
  let i = at + 2;
  while (i < lines.length && lines[i].trim() && isTableRow(lines[i]) && !isDelimiterRow(lines[i])) { rows.push(splitRow(lines[i])); i++; }
  return { block: { type: 'table', align, head: cells.map(cell => parseInline(cell, options)),
    rows: rows.map(row => cells.map((_cell, index) => parseInline(row[index] ?? '', options))) }, next: i };
}

export function parseMarkdown(text, options = {}) {
  const source = text == null ? '' : String(text);
  return parseBlocks(source.replace(/\r\n?/g, '\n').split('\n'), options);
}

function parseBlocks(lines, options = {}) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const lang = (fence[2] || '').trim();
      const body = [];
      let j = i + 1, closed = false;
      while (j < lines.length) {
        const close = FENCE.exec(lines[j]);
        if (close && close[1][0] === marker && !close[2]) { closed = true; break; }
        body.push(lines[j]); j++;
      }
      if (closed) {
        const text = body.join('\n');
        blocks.push(options.diagrams === true && lang.toLowerCase() === 'mermaid'
          ? { type: 'diagram', lang: 'mermaid', text }
          : { type: 'code', lang, text });
        i = j + 1; continue;
      }
      // 围栏未闭合：当作普通段落继续往下走，不抛错也不吞掉后续内容
    }
    if (HR.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }

    const table = tableStart(lines, i, options);
    if (table) { blocks.push(table.block); i = table.next; continue; }

    const heading = HEADING.exec(line);
    if (heading) { blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2], options) }); i++; continue; }

    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) { inner.push(QUOTE.exec(lines[i])[1]); i++; }
      blocks.push({ type: 'quote', blocks: parseBlocks(inner, options) });
      continue;
    }
    if (UL.test(line) || OL.test(line)) {
      const ordered = OL.test(line);
      const items = [];
      while (i < lines.length) {
        const match = ordered ? OL.exec(lines[i]) : UL.exec(lines[i]);
        if (!match) break;
        let value = match[1]; i++;
        // 缩进的续行并入当前列表项
        while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) { value += `\n${lines[i].trim()}`; i++; }
        items.push(parseInline(value, options));
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const para = [];
    // 段落里遇上表格开头要停下来，否则表头会被吞进上一段。
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !tableStart(lines, i, options)) { para.push(lines[i]); i++; }
    if (!para.length) { para.push(lines[i]); i++; }   // 保证一定前进，避免死循环
    blocks.push({ type: 'paragraph', children: parseInline(para.join('\n'), options) });
  }
  return blocks;
}

/* ---------------- render ---------------- */

function renderInline(nodes, doc, options) {
  return nodes.map(node => {
    switch (node.type) {
      case 'text': return doc.createTextNode(node.value);
      case 'br': return doc.createElement('br');
      case 'strong': { const el = doc.createElement('strong'); el.append(...renderInline(node.children, doc, options)); return el; }
      case 'em': { const el = doc.createElement('em'); el.append(...renderInline(node.children, doc, options)); return el; }
      case 'code': { const el = doc.createElement('code'); el.append(doc.createTextNode(node.value)); return el; }
      case 'link': {
        const el = doc.createElement('a');
        el.setAttribute('href', node.href);
        if (node.external) {
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
        }
        el.append(...renderInline(node.children, doc, options));
        return el;
      }
      default: return doc.createTextNode(String(node.value ?? ''));
    }
  });
}

function renderBlock(block, doc, options) {
  switch (block.type) {
    case 'heading': { const el = doc.createElement(`h${block.level}`); el.append(...renderInline(block.children, doc, options)); return el; }
    case 'paragraph': { const el = doc.createElement('p'); el.append(...renderInline(block.children, doc, options)); return el; }
    case 'hr': return doc.createElement('hr');
    case 'code': {
      const box = doc.createElement('div'); box.setAttribute('class', 'md-code');
      const lang = String(block.lang || '').replace(/[^A-Za-z0-9+#._-]/g, '').slice(0, 32);
      if (lang) {
        const label = doc.createElement('span'); label.setAttribute('class', 'md-lang');
        label.append(doc.createTextNode(lang)); box.append(label);
      }
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      if (lang) code.setAttribute('class', `language-${lang}`);
      code.append(doc.createTextNode(block.text));
      pre.append(code); box.append(pre);
      return box;
    }
    case 'diagram': {
      const box = doc.createElement('div');
      box.setAttribute('class', 'mermaid md-mermaid');
      box.setAttribute('data-mermaid-state', 'pending');
      box.setAttribute('role', 'img');
      box.setAttribute('aria-label', '流程图');
      box.append(doc.createTextNode(block.text));
      return box;
    }
    case 'list': {
      const list = doc.createElement(block.ordered ? 'ol' : 'ul');
      for (const item of block.items) { const li = doc.createElement('li'); li.append(...renderInline(item, doc, options)); list.append(li); }
      return list;
    }
    case 'quote': {
      const quote = doc.createElement('blockquote');
      quote.append(...block.blocks.map(child => renderBlock(child, doc, options)));
      return quote;
    }
    case 'table': {
      const table = doc.createElement('table');
      const align = index => (block.align[index] ? { style: `text-align:${block.align[index]}` } : null);
      const thead = doc.createElement('thead'), headRow = doc.createElement('tr');
      block.head.forEach((cell, index) => {
        const th = doc.createElement('th');
        const style = align(index); if (style) th.setAttribute('style', style.style);
        th.append(...renderInline(cell, doc, options)); headRow.append(th);
      });
      thead.append(headRow); table.append(thead);
      const tbody = doc.createElement('tbody');
      for (const row of block.rows) {
        const tr = doc.createElement('tr');
        row.forEach((cell, index) => {
          const td = doc.createElement('td');
          const style = align(index); if (style) td.setAttribute('style', style.style);
          td.append(...renderInline(cell, doc, options)); tr.append(td);
        });
        tbody.append(tr);
      }
      table.append(tbody);
      return table;
    }
    default: { const el = doc.createElement('p'); return el; }
  }
}

function plainFallback(doc, source, reason) {
  const wrap = doc.createElement('div');
  wrap.setAttribute('class', 'markdown md-plain');
  wrap.setAttribute('data-fallback', reason);
  const hint = doc.createElement('p');
  hint.setAttribute('class', 'hint');
  hint.append(doc.createTextNode(reason === 'too-long'
    ? `文本过长（${source.length} 字），已按纯文本显示。`
    : '渲染失败，已按纯文本显示。'));
  const pre = doc.createElement('pre');
  pre.append(doc.createTextNode(source));
  wrap.append(hint, pre);
  return wrap;
}

/**
 * 把文本渲染成 DOM 节点（默认 div.markdown）。
 * 超长或解析异常时返回 data-fallback 标记的纯文本 <pre>，不抛错。
 */
export function renderMarkdown(text, doc = globalThis.document, options = {}) {
  const source = text == null ? '' : String(text);
  if (source.length > MAX_MARKDOWN_LENGTH) return plainFallback(doc, source, 'too-long');
  const wrap = doc.createElement('div');
  wrap.setAttribute('class', 'markdown');
  try {
    for (const block of parseMarkdown(source, options)) wrap.append(renderBlock(block, doc, options));
  } catch {
    return plainFallback(doc, source, 'error');
  }
  return wrap;
}
