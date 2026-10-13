import { docsIndex, docsSearchIndex, readDoc } from './docs.js';

/** Code-shipped documents and assets do not attach a daemon; callers enforce authentication. */
export function contentRead({ request, url, headers, json }, staticAssets) {
  if (url.pathname === '/favicon.ico') return new Response(null, { status: 204, headers });
  // 「文档」页：读的是随这份代码发布的 docs/**/*.md 与 README.md，与当前项目目录无关。
  // 只接受已扫出的 id，请求里的字符串不进文件系统路径，未知 id 与非 .md 一律 404。
  if (url.pathname === '/api/docs') return json({ docs: docsIndex() });
  if (url.pathname === '/api/docs/search-index') return json({ docs: docsSearchIndex() });
  const doc = /^\/api\/docs\/([a-z0-9._-]+)$/.exec(url.pathname);
  if (doc) {
    const found = readDoc(doc[1]);
    return found ? json(found) : json({ error: `no such document: ${doc[1]}` }, 404);
  }
  // Static caches sit behind the same Host, Origin and authentication checks as APIs.
  const asset = staticAssets.response(url.pathname, request, headers);
  if (asset) return asset;
  return null;
}
