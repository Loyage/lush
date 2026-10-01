import { el } from './dom.js';
import { enhanceCode, languageFromPath } from './code-highlight.js';

function code(text, path) {
  const node = el('code', text, 'code-line-text'); node.codeSourceText = text;
  enhanceCode(node, text, languageFromPath(path));
  return node;
}
function cell(line, side, path) {
  const node = el('div', undefined, `code-diff-cell code-${line?.kind || 'empty'}`);
  const number = side === 'old' ? line?.old_line : line?.new_line;
  const gutter = el('span', number == null ? '' : String(number), 'code-line-number');
  gutter.setAttribute('aria-hidden', 'true');
  const sign = el('span', line?.kind === 'add' ? '+' : line?.kind === 'delete' ? '−' : '', 'code-line-sign');
  sign.setAttribute('aria-hidden', 'true');
  node.append(gutter, sign, code(line?.text ?? '', path));
  return node;
}
function unifiedLine(line, path) {
  const row = el('div', undefined, `code-unified-line code-${line.kind}`);
  for (const number of [line.old_line, line.new_line]) {
    const gutter = el('span', number == null ? '' : String(number), 'code-line-number');
    gutter.setAttribute('aria-hidden', 'true'); row.append(gutter);
  }
  row.append(el('span', line.kind === 'add' ? '+' : line.kind === 'delete' ? '−' : '', 'code-line-sign'), code(line.text, path));
  return row;
}

/** Pure projection of server hunks; never reparses file content as markup or recomputes a diff. */
export function renderCodeDiff(hunks, path) {
  const root = el('div', undefined, 'code-hunks');
  for (const hunk of hunks) {
    const section = el('section', undefined, 'code-hunk'); section.tabIndex = -1;
    section.append(el('h3', `@@ −${hunk.old_start},${hunk.old_count} +${hunk.new_start},${hunk.new_count} @@`, 'code-hunk-heading'));
    const unified = el('div', undefined, 'code-unified');
    const split = el('div', undefined, 'code-split');
    const sides = el('div', undefined, 'code-diff-sides'); sides.append(el('span', '基线版本'), el('span', '当前版本')); split.append(sides);
    const lines = hunk.lines || [];
    for (const line of lines) unified.append(unifiedLine(line, path));
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      if (line.kind === 'context') {
        const row = el('div', undefined, 'code-split-row'); row.append(cell(line, 'old', path), cell(line, 'new', path)); split.append(row); i++;
      } else if (line.kind === 'meta') {
        split.append(el('div', line.text, 'code-meta')); i++;
      } else {
        const removed = [], added = [];
        while (i < lines.length && ['delete', 'add'].includes(lines[i].kind)) {
          (lines[i].kind === 'delete' ? removed : added).push(lines[i++]);
        }
        for (let n = 0; n < Math.max(removed.length, added.length); n++) {
          const row = el('div', undefined, 'code-split-row'); row.append(cell(removed[n], 'old', path), cell(added[n], 'new', path)); split.append(row);
        }
        // Unknown future line kinds remain visible instead of trapping the reader in a loop.
        if (!removed.length && !added.length) { split.append(el('div', line.text, 'code-meta')); i++; }
      }
    }
    section.append(unified, split); root.append(section);
  }
  return root;
}

/** One bounded segment. A segment may start/end inside a long line; its byte-exact text stays selectable. */
export function renderCodeContent(content, path) {
  const root = el('section', undefined, 'code-content-segment'); root.codeContent = { ...content };
  root.append(el('p', contentLabel(content), 'hint code-segment-label'));
  const lines = String(content.text ?? '').split('\n');
  // The last empty split component represents the trailing newline, not an additional source line.
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  if (!content.text) { root.append(el('p', '此段为空。', 'hint')); return root; }
  const table = el('div', undefined, 'code-content-lines');
  for (let i = 0; i < lines.length; i++) {
    const row = el('div', undefined, 'code-content-line'); row.dataset.line = String((content.line_start ?? 1) + i);
    const number = el('span', content.line_continued === true && i === 0 ? '↳' : row.dataset.line, 'code-line-number'); number.setAttribute('aria-hidden', 'true');
    row.append(number, code(lines[i] + (i < lines.length - 1 || String(content.text).endsWith('\n') ? '\n' : ''), path)); table.append(row);
  }
  root.append(table); return root;
}

function contentLabel(content) {
  return `第 ${content.line_start ?? 1} 行${content.line_continued === true ? '接续（不是新行）' : '起'} · 字符 ${content.offset}–${content.next_offset}`;
}

/** Continue a split line in place, without inventing a newline or a second source line number. */
export function appendCodeContent(container, content, path) {
  const previous = [...container.querySelectorAll('.code-content-segment')].at(-1);
  if (content.line_continued !== true || !previous) {
    const segment = renderCodeContent(content, path); container.append(segment); return [segment];
  }
  const line = [...previous.querySelectorAll('.code-content-line')].at(-1);
  const text = line?.querySelector('.code-line-text');
  if (previous.codeContent?.next_offset !== content.offset || line?.dataset.line !== String(content.line_start)
    || !text || text.codeSourceText.endsWith('\n')) throw new Error('续行位置与已读取正文不一致，请加载最新后重试');
  const raw = String(content.text ?? ''), newline = raw.indexOf('\n');
  const consumed = newline < 0 ? raw.length : newline + 1, fragment = raw.slice(0, consumed);
  const replacement = code(text.codeSourceText + fragment, path); line.insertBefore(replacement, text); text.remove();
  previous.codeContent.text += fragment; previous.codeContent.next_offset = content.offset + consumed;
  previous.codeContent.has_more = raw.length > consumed || content.has_more;
  previous.querySelector('.code-segment-label').textContent = contentLabel(previous.codeContent);
  const updated = [previous];
  if (raw.length > consumed) {
    const rest = { ...content, text: raw.slice(consumed), offset: content.offset + consumed,
      line_start: content.line_start + 1, line_continued: false };
    const segment = renderCodeContent(rest, path); container.append(segment); updated.push(segment);
  }
  return updated;
}
