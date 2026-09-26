import { el, button } from './dom.js';
import { agentText } from './text.js';
import { structuredValue } from './structured-value.js';
import { ui } from './state.js';
import { enhanceCode, languageFromPath } from './code-highlight.js';

const LABELS = { command: '命令', path: '文件', file_path: '文件', offset: '起始行', limit: '读取上限',
  pattern: '匹配模式', query: '查询', glob: '文件匹配', content: '写入内容', oldText: '修改前', newText: '修改后',
  old_string: '修改前', new_string: '修改后', timeout: '超时（秒）', url: '网址', description: '说明' };
const CONTENT_FIELDS = ['content', 'text', 'oldText', 'newText', 'old_string', 'new_string', 'prompt', 'description'];

/** Bound the preview, not the original. Text newlines are never JSON-escaped for reading. */
function readableText(value, { markdown = false, preview = true, key, expanded = false, language = null, plain = false } = {}) {
  const text = String(value ?? '');
  const lines = text.split('\n');
  const excerpt = lines.slice(0, 10).join('\n').slice(0, 1000);
  const long = preview && excerpt.length < text.length;
  const root = el('div', undefined, 'transcript-text');
  const content = el('div');
  const render = full => {
    const shown = !long || full ? text : excerpt;
    if (markdown && !plain) { content.replaceChildren(agentText(shown, { plain: 'pre', className: 'transcript-prose' })); return; }
    const pre = el('pre', shown, 'readable-value');
    content.replaceChildren(pre);
    // 只在富文本模式为已知语言的正文着色；终端纯文本模式保持原样。
    if (!plain && language) enhanceCode(pre, shown, language);
  };
  let open = key && ui.stepToggle.has(key) ? ui.stepToggle.get(key) : expanded;
  render(open); root.append(content);
  if (long) {
    const toggle = button('', () => {
      open = !open; if (key) ui.stepToggle.set(key, open);
      render(open); paint();
    }, 'ghost content-expand');
    const paint = () => {
      toggle.textContent = open ? '收起为预览' : `展开剩余内容（本段 ${text.length.toLocaleString()} 字符）`;
      toggle.setAttribute('aria-expanded', String(open));
    };
    paint(); root.append(toggle);
  }
  return root;
}

/* ---------------- 终端纯文本（与富文本共用同一个入口，只差 plain） ---------------- */

/** Decode tool strings without a collapsed JSON tree; bound formatting work, never drop fields. */
function plainValue(value, depth = 0, budget = { left: 500 }) {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object' || depth >= 12 || --budget.left < 0) return JSON.stringify(value, null, 2);
  const entries = Object.entries(value);
  if (!entries.length) return Array.isArray(value) ? '[]' : '{}';
  return entries.map(([key, item]) => `${Array.isArray(value) ? `[${key}]` : key}:\n${plainValue(item, depth + 1, budget).split('\n').map(line => `  ${line}`).join('\n')}`).join('\n');
}

function appendPlain(root, step, text) {
  let value;
  if (step.kind === 'tool') {
    try { if (!step.body_truncated && !(step.body_length > text.length)) value = JSON.parse(text); } catch { /* keep raw */ }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length || Object.keys(value).length > 100) {
    root.append(el('pre', text, 'terminal-text'));
    return;
  }
  for (const [name, item] of Object.entries(value)) {
    root.append(el('div', name === 'command' ? '$ command' : name, 'terminal-field'), el('pre', plainValue(item), 'terminal-text'));
  }
}

/** Semantic reading only. Exact arguments/output remain available through the source control. */
export function transcriptBody(step, { key = '', preview = true, plain = false } = {}) {
  const root = el('div', undefined, plain ? 'transcript-content transcript-plain' : 'transcript-content');
  const text = String(step.body ?? '');
  if (plain) { appendPlain(root, step, text); return root; }
  const options = { preview, key: `${key}:body`, expanded: Boolean(step.is_error) };
  if (['text', 'thinking'].includes(step.kind)) {
    root.append(readableText(text, { ...options, markdown: true })); return root;
  }
  let value;
  try {
    if (!step.body_truncated && !(step.body_length > text.length)) value = JSON.parse(text);
  } catch { /* partial/legacy records stay faithful text */ }
  if (step.kind !== 'tool' || !value || Array.isArray(value) || typeof value !== 'object') {
    if (value && typeof value === 'object') root.append(structuredValue(text, { openRoot: true, preview: preview && !step.is_error }));
    else root.append(readableText(typeof value === 'string' ? value : text, options));
    return root;
  }
  const pathHint = value.path ?? value.file_path ?? null;
  const field = (name, item, suffix = name, language = null) => {
    const box = el('section', undefined, `tool-field${['oldText', 'old_string'].includes(name) ? ' change-before' : ['newText', 'new_string'].includes(name) ? ' change-after' : ''}`);
    box.append(el('h5', LABELS[name] || name));
    const isContent = ['command', 'content', 'oldText', 'newText', 'old_string', 'new_string', 'text', 'prompt', 'description'].includes(name);
    if (!isContent && (item === null || typeof item !== 'object') && !String(item).includes('\n') && String(item).length <= 240) {
      box.classList.add('tool-field-inline'); box.append(el('span', item === null ? 'null' : String(item), 'tool-value'));
    }
    else if (item && typeof item === 'object') box.append(structuredValue(JSON.stringify(item, null, 2), { openRoot: true, preview }));
    else box.append(readableText(item === null ? 'null' : item, { ...options, key: `${key}:${suffix}`,
      // The operation itself should not disappear behind a preview.
      preview: preview && name !== 'command', language }));
    return box;
  };
  const entries = Object.entries(value);
  for (const [name, item] of entries.slice(0, 40)) {
    if (name === 'edits' && Array.isArray(item)) {
      item.slice(0, 20).forEach((edit, index) => {
        if (!edit || typeof edit !== 'object' || Array.isArray(edit)) { root.append(field(name, edit, `edit:${index}`)); return; }
        const change = el('section', undefined, 'tool-edit'); change.append(el('h5', `修改 ${index + 1}`));
        for (const [part, content] of Object.entries(edit).slice(0, 40)) change.append(field(part, content, `edit:${index}:${part}`, languageFromPath(pathHint)));
        root.append(change);
      });
      if (item.length > 20) root.append(el('p', '仅预览前 20 处修改；其余见原文。', 'hint'));
    } else {
      const language = name === 'command' ? 'bash' : (CONTENT_FIELDS.includes(name) ? languageFromPath(pathHint) : null);
      root.append(field(name, item, name, language));
    }
  }
  if (!entries.length) root.append(el('p', '无参数', 'hint'));
  if (entries.length > 40) root.append(el('p', '仅预览前 40 个字段；其余见原文。', 'hint'));
  return root;
}
