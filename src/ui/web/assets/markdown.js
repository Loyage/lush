// 极简 Markdown 渲染器：纯解析 + createElement/textContent 构建 DOM。
// 不引入任何第三方依赖，不使用 innerHTML，所有文本都经过 DOM 文本节点。
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

function parseInline(text) {
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
      if (match) { flush(); nodes.push(linkNode(match[1], match[2])); i += match[0].length; continue; }
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
          nodes.push({ type: delim.length === 2 ? 'strong' : 'em', children: parseInline(text.slice(i + delim.length, end)) });
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

function linkNode(label, raw) {
  const href = safeUrl(raw);
  if (!href) return { type: 'text', value: raw ? `${label} (${raw})` : label };
  return { type: 'link', href, children: parseInline(label) };
}

/* ---------------- blocks ---------------- */

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const UL = /^ {0,3}[-*+]\s+(.*)$/;
const OL = /^ {0,3}\d{1,9}[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;

const startsBlock = line => FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || UL.test(line) || OL.test(line);

export function parseMarkdown(text) {
  const source = text == null ? '' : String(text);
  return parseBlocks(source.replace(/\r\n?/g, '\n').split('\n'));
}

function parseBlocks(lines) {
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
      if (closed) { blocks.push({ type: 'code', lang, text: body.join('\n') }); i = j + 1; continue; }
      // 围栏未闭合：当作普通段落继续往下走，不抛错也不吞掉后续内容
    }
    if (HR.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }

    const heading = HEADING.exec(line);
    if (heading) { blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2]) }); i++; continue; }

    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) { inner.push(QUOTE.exec(lines[i])[1]); i++; }
      blocks.push({ type: 'quote', blocks: parseBlocks(inner) });
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
        items.push(parseInline(value));
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) { para.push(lines[i]); i++; }
    if (!para.length) { para.push(lines[i]); i++; }   // 保证一定前进，避免死循环
    blocks.push({ type: 'paragraph', children: parseInline(para.join('\n')) });
  }
  return blocks;
}

/* ---------------- render ---------------- */

function renderInline(nodes, doc) {
  return nodes.map(node => {
    switch (node.type) {
      case 'text': return doc.createTextNode(node.value);
      case 'br': return doc.createElement('br');
      case 'strong': { const el = doc.createElement('strong'); el.append(...renderInline(node.children, doc)); return el; }
      case 'em': { const el = doc.createElement('em'); el.append(...renderInline(node.children, doc)); return el; }
      case 'code': { const el = doc.createElement('code'); el.append(doc.createTextNode(node.value)); return el; }
      case 'link': {
        const el = doc.createElement('a');
        el.setAttribute('href', node.href);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
        el.append(...renderInline(node.children, doc));
        return el;
      }
      default: return doc.createTextNode(String(node.value ?? ''));
    }
  });
}

function renderBlock(block, doc) {
  switch (block.type) {
    case 'heading': { const el = doc.createElement(`h${block.level}`); el.append(...renderInline(block.children, doc)); return el; }
    case 'paragraph': { const el = doc.createElement('p'); el.append(...renderInline(block.children, doc)); return el; }
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
    case 'list': {
      const list = doc.createElement(block.ordered ? 'ol' : 'ul');
      for (const item of block.items) { const li = doc.createElement('li'); li.append(...renderInline(item, doc)); list.append(li); }
      return list;
    }
    case 'quote': {
      const quote = doc.createElement('blockquote');
      quote.append(...block.blocks.map(child => renderBlock(child, doc)));
      return quote;
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
export function renderMarkdown(text, doc = globalThis.document) {
  const source = text == null ? '' : String(text);
  if (source.length > MAX_MARKDOWN_LENGTH) return plainFallback(doc, source, 'too-long');
  const wrap = doc.createElement('div');
  wrap.setAttribute('class', 'markdown');
  try {
    for (const block of parseMarkdown(source)) wrap.append(renderBlock(block, doc));
  } catch {
    return plainFallback(doc, source, 'error');
  }
  return wrap;
}
