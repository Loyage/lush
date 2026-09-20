/**
 * 「文档」视图：左栏 workspace-nav 的「文档」进入，右栏整页阅读。
 *
 * 文档随这份代码发布（`docs/` 与根 `README.md`），由 `src/ui/web/docs.js` 提供索引与正文；
 * 这里只负责路由（`#docs` / `#doc-<id>`）、取数与相对链接解析，渲染在 render-docs.js。
 * 与「分支图」（render-graph.js 的 openGraph）同构：同一个右栏、同一个排他标志、同一套 hash 路由。
 *
 * 相对链接为什么要在浏览器里解析：文档之间互相引用（`entities.md`、`../README.md`），
 * markdown.js 默认只放行 http/https，所以这里给它一个解析器，把站内路径换成 `#doc-<id>`
 * ——走同一个 hash 路由，浏览器后退与直接分享链接都照常。解析不出来（比如指向 src/ 的链接）
 * 返回 null，退回默认行为（显示成 `标题 (路径)` 的纯文本）。
 */
import { api } from './api.js';
import { renderDoc, renderDocError, renderDocsIndex } from './render-docs.js';
import { ui } from './state.js';

const DOC_HASH = /^#doc-([a-z0-9._-]+)$/;
export const DOCS_HASH = '#docs';

/** 地址栏 hash → 文档目标：null 表示这不是文档路由；`{ id: null }` 表示文档目录。 */
export function docsTarget(hash) {
  if (hash === DOCS_HASH) return { id: null };
  const match = DOC_HASH.exec(hash);
  return match ? { id: match[1] } : null;
}

/** 把文档里的相对链接解析成仓库内路径；绝对 URL、协议相对、站内绝对路径都不算文档链接。 */
export function resolveDocPath(from, raw) {
  const value = String(raw ?? '').trim();
  if (!value || value.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  const clean = value.split('#')[0].split('?')[0].trim();
  if (!clean) return null;
  const at = from.lastIndexOf('/');
  const base = at < 0 ? '' : from.slice(0, at);
  const out = [];
  for (const part of `${base}/${clean}`.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}

/** 给 renderMarkdown 的链接解析器：指向另一篇文档就返回站内 hash，其余返回 null 交给默认规则。 */
export function docLinkResolver(current, docs) {
  const byPath = new Map(docs.map(entry => [entry.path, entry]));
  return raw => {
    const target = resolveDocPath(current.path, raw);
    const hit = target ? byPath.get(target) : null;
    return hit ? { href: `#doc-${hit.id}`, external: false } : null;
  };
}

/** 打开文档目录（id 为 null）或某一篇：清掉选中的任务（否则热任务刷新会把文档覆盖掉），地址栏切到对应 hash。 */
export async function openDocs(id = null) {
  ui.docsOpen = true;
  ui.graphOpen = false; ui.graphRenderKey = null;
  ui.selected = null; ui.selectedRevision = null; ui.detailDirty = false; ui.detailTask = null;
  const hash = id ? `#doc-${id}` : DOCS_HASH;
  if (location.hash !== hash) window.history.pushState(null, '', hash);
  await loadDocs(id);
}

/**
 * 取数并渲染。失败在右栏画错误页、不往外抛：面板本身就是给用户看的输出，
 * 抛出去只会让调用方把同一条错误再写一遍到 #error。
 */
export async function loadDocs(id = null) {
  try {
    const index = await api('/api/docs');
    if (!id) { renderDocsIndex(index.docs, openDocs); return; }
    const entry = index.docs.find(row => row.id === id);
    if (!entry) { renderDocError(id, `没有这篇文档（${id}）`, openDocs); return; }
    const doc = await api(`/api/docs/${id}`);
    renderDoc(doc, docLinkResolver(doc, index.docs), openDocs);
  } catch (error) {
    renderDocError(id, error.message, openDocs);
  }
}
