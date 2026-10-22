import fs from 'node:fs';
import { WEB_PUSH_PATHS } from '../../shared/web-push-protocol.js';
import { pwaWorkerSource } from './pwa-worker.js';

const manifest = JSON.stringify({
  id: '/', name: 'Lush', short_name: 'Lush', lang: 'zh-CN',
  start_url: '/', scope: '/', display: 'standalone',
  background_color: '#0f1613', theme_color: '#0f1613',
  icons: [192, 512].map(size => ({ src: `/pwa/icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' })),
});
const assets = new Map([
  [WEB_PUSH_PATHS.manifest, { type: 'application/manifest+json; charset=utf-8', body: manifest }],
  [WEB_PUSH_PATHS.worker, { type: 'text/javascript; charset=utf-8', body: pwaWorkerSource(), worker: true }],
  ...['icon-192.png', 'icon-512.png', 'apple-touch-icon.png'].map(name => [
    `/pwa/${name}`, { type: 'image/png', body: fs.readFileSync(new URL(`./pwa/${name}`, import.meta.url)) },
  ]),
]);

/** The only pre-login assets: fixed, code-shipped, user-data-free PWA files.
 * Stable URLs and no-store let the browser update its worker even after a session expires.
 * No filesystem path or request-derived content reaches this map.
 */
export function pwaResponse({ request, url, headers }) {
  if (!['GET', 'HEAD'].includes(request.method) || url.search) return null;
  const asset = assets.get(url.pathname);
  if (!asset) return null;
  return new Response(request.method === 'HEAD' ? null : asset.body, { headers: {
    ...headers, 'Content-Type': asset.type, 'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(asset.body)),
    ...(asset.worker ? { 'Service-Worker-Allowed': '/' } : {}),
  } });
}
