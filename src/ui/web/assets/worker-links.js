import { api } from './api.js';

const NUMBER = /^W[1-9]\d*(?:-[1-9]\d*)*$/;
const validNumber = value => typeof value === 'string' && value.length <= 2048 && NUMBER.test(value)
  && value.slice(1).split('-').every(segment => Number.isSafeInteger(Number(segment)));
// Do not link partial identifiers, filenames, paths or URLs. Chinese punctuation may
// directly surround a number; ASCII identifier/path characters may not.
const MENTIONS = /(?<![\w./#-])(?:W[1-9]\d*(?:-[1-9]\d*)*|[DNO][1-9]\d*)(?![\w/-]|\.[\w])/g;
const validMention = value => value.startsWith('W') ? validNumber(value) : /^[DNO][1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value.slice(1)));
const SKIP = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'PRE', 'CODE', 'SCRIPT', 'STYLE', 'IFRAME', 'SVG']);

export function workerNumberTarget(hash) {
  const number = String(hash).replace(/^#worker-number-/, '');
  return String(hash).startsWith('#worker-number-') && validNumber(number) ? number : null;
}

export async function resolveWorkerNumber(number) {
  if (!validNumber(number)) throw new Error('无效的 Worker 编号');
  const worker = await api(`/api/worker-lookup?number=${encodeURIComponent(number)}`);
  if (worker?.worker_number !== number || !Number.isSafeInteger(worker?.id) || worker.id <= 0)
    throw new Error(`无法定位 Worker ${number}`);
  return worker.id;
}

/** Explicit render-time enhancement: no observers, background lookups or data rewrites. */
export function linkWorkerNumbers(root, doc = globalThis.document) {
  function parts(text) {
    const matches = [...text.matchAll(MENTIONS)].filter(match => validMention(match[0]));
    if (!matches.length) return null;
    const nodes = []; let at = 0;
    for (const match of matches) {
      if (match.index > at) nodes.push(doc.createTextNode(text.slice(at, match.index)));
      const link = doc.createElement('a');
      link.textContent = match[0];
      const number = match[0], worker = number.startsWith('W'), input = number.startsWith('O');
      link.setAttribute('class', worker ? 'worker-link' : 'record-link');
      link.setAttribute('href', worker ? `#worker-number-${number}` : input ? `#input-input-${number.slice(1)}` : `#notices-${number.slice(1)}`);
      link.setAttribute('aria-label', worker ? `查看 Worker ${number} 的详情` : `查看${input ? '原始输入' : number.startsWith('D') ? '用户决定' : '告知'} ${number} 的详情`);
      // Native navigation (including Ctrl/Command-click) is preserved. A surrounding
      // selectable card must not interpret viewing a Worker as choosing an answer.
      link.onclick = event => event?.stopPropagation();
      nodes.push(link); at = match.index + match[0].length;
    }
    if (at < text.length) nodes.push(doc.createTextNode(text.slice(at)));
    return nodes;
  }
  function visit(node) {
    if ((SKIP.has(node.tagName) && !(node === root && node.tagName === 'PRE')) || node.isContentEditable || node.getAttribute?.('contenteditable') === 'true'
      || node.getAttribute?.('data-worker-links') === 'off') return;
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3 || child.tagName === '#TEXT') {
        const nodes = parts(child.textContent);
        if (nodes) { for (const replacement of nodes) node.insertBefore(replacement, child); child.remove(); }
      } else visit(child);
    }
    // Tiny DOM adapters may store leaf text without a child text node.
    if (!node.childNodes.length && node.textContent) {
      const nodes = parts(node.textContent);
      if (nodes) { node.textContent = ''; node.append(...nodes); }
    }
  }
  visit(root);
  return root;
}
