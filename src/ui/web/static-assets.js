import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

const ASSETS = fileURLToPath(new URL('./assets/', import.meta.url));
const BUILDER = fileURLToPath(new URL('./build-assets.js', import.meta.url));
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|css)$/;
const VERSIONED = /^web-([a-f0-9]{32})-[A-Za-z0-9._-]+\.(?:js|css)$/;
const GENERATIONS = 3;
const MAX_BYTES = 32 * 1024 * 1024;
let shared;

function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function safeFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Unsafe Web asset file');
  return stat;
}
function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error('Unsafe Web asset cache directory');
  }
}
function representation(bytes, type, immutable = false) {
  const gzip = gzipSync(bytes);
  return { bytes, gzip, type, immutable,
    etags: { identity: `"${digest(bytes)}"`, gzip: `"${digest(gzip)}"` } };
}
function typeOf(name) { return name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'; }

// Respect explicit q=0 before wildcard; identity is acceptable unless explicitly excluded.
export function staticEncoding(header = '') {
  const weights = new Map();
  for (const part of header.toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    if (!name) continue;
    let q = 1;
    for (const param of params) if (param.trim().startsWith('q=')) {
      const value = param.trim().slice(2);
      q = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value) ? Number(value) : 0;
    }
    weights.set(name, q);
  }
  const gzip = weights.get('gzip') ?? weights.get('*') ?? 0;
  const identity = weights.get('identity') ?? (weights.get('*') === 0 ? 0 : 1);
  if (gzip > 0 && gzip >= identity) return 'gzip';
  return identity > 0 ? 'identity' : gzip > 0 ? 'gzip' : null;
}

/** Process-shared immutable buffers; disk retains 3 content generations (<=32 MiB each).
 * This bounded, owner-only temp cache lets old HTML finish imports after a Host update.
 * Once evicted, an old URL is 404/no-store, never substituted with a different version.
 * Legacy basename modules remain no-store for pre-bundle HTML and pinned vendor loaders.
 */
export function createStaticAssets({ assets = ASSETS, cache = path.join(os.tmpdir(), `lush-web-assets-${process.getuid()}`) } = {}) {
  privateDirectory(cache);
  const hash = createHash('sha256').update(`web-assets-v1:${Bun.version}`);
  hash.update(fs.readFileSync(BUILDER));
  hash.update(fs.readFileSync(fileURLToPath(import.meta.url)));
  for (const name of fs.readdirSync(assets).filter(name => NAME.test(name) || name === 'index.html').sort()) {
    safeFile(path.join(assets, name));
    hash.update(name).update('\0').update(fs.readFileSync(path.join(assets, name))).update('\0');
  }
  const version = hash.digest('hex').slice(0, 32);
  const archive = path.join(cache, `${version}.json`);
  const unpack = file => {
    const stat = safeFile(file);
    if (stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Unsafe Web asset archive');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record.version !== path.basename(file, '.json')) throw new Error('Invalid Web asset version');
    const files = new Map(); let bytes = 0;
    for (const [name, entry] of Object.entries(record.files)) {
      if (name !== 'index.html' && (!VERSIONED.test(name) || !name.startsWith(`web-${record.version}-`))) throw new Error('Invalid Web asset name');
      const data = Buffer.from(entry.bytes, 'base64');
      if (digest(data) !== entry.digest) throw new Error('Invalid Web asset contents');
      bytes += data.length;
      if (bytes > MAX_BYTES) throw new Error('Web asset generation too large');
      files.set(name, representation(data, name === 'index.html' ? 'text/html; charset=utf-8' : typeOf(name), name !== 'index.html'));
    }
    if (!files.has('index.html')) throw new Error('Missing Web HTML');
    return files;
  };
  let current;
  if (fs.existsSync(archive)) { try { current = unpack(archive); } catch { /* Rebuild corrupt cache; never serve it. */ } }
  if (!current) {
    const outdir = fs.mkdtempSync(path.join(cache, '.build-'));
    try {
      const result = spawnSync(process.execPath, [BUILDER, assets, outdir, version], { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
      if (result.error || result.status !== 0) {
        const details = [result.error?.message, result.stderr, result.stdout].filter(Boolean).join('\n').trim();
        throw new Error(`Web asset build failed (exit=${result.status ?? '-'}, signal=${result.signal || '-'}): ${details}`);
      }
      const files = {}; let bytes = 0;
      for (const name of fs.readdirSync(outdir)) {
        safeFile(path.join(outdir, name));
        const data = fs.readFileSync(path.join(outdir, name)); bytes += data.length;
        if (bytes > MAX_BYTES) throw new Error('Web asset generation too large');
        files[name] = { bytes: data.toString('base64'), digest: digest(data) };
      }
      const temporary = path.join(outdir, 'archive.json');
      const json = JSON.stringify({ version, files });
      if (Buffer.byteLength(json) > MAX_BYTES) throw new Error('Web asset archive too large');
      fs.writeFileSync(temporary, json, { mode: 0o600 });
      fs.renameSync(temporary, archive);
      current = unpack(archive);
    } finally { fs.rmSync(outdir, { recursive: true, force: true }); }
  }
  // Mark the active generation as recent. Only known cache files are pruned.
  fs.utimesSync(archive, new Date(), new Date());
  const archives = fs.readdirSync(cache).filter(name => /^[a-f0-9]{32}\.json$/.test(name))
    .map(name => ({ name, mtime: fs.lstatSync(path.join(cache, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  const files = new Map(current);
  for (const { name } of archives.filter(row => row.name !== `${version}.json`).slice(0, GENERATIONS - 1)) {
    try { for (const [key, value] of unpack(path.join(cache, name))) if (key !== 'index.html') files.set(key, value); } catch { /* Ignore invalid/removed history. */ }
  }
  for (const { name } of archives.filter(row => row.name !== `${version}.json`).slice(GENERATIONS - 1)) fs.rmSync(path.join(cache, name), { force: true });
  const legacy = new Map(); let legacyBytes = 0;
  return {
    version,
    response(pathname, request, headers) {
      const name = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (pathname !== '/' && !NAME.test(name)) return null;
      let asset = files.get(name);
      if (!asset && !VERSIONED.test(name) && name !== 'index.html') {
        asset = legacy.get(name);
        if (!asset) {
          const file = path.join(assets, name);
          if (!fs.existsSync(file)) return null;
          safeFile(file);
          asset = representation(fs.readFileSync(file), typeOf(name));
          const size = asset.bytes.length + asset.gzip.length;
          // Legacy modules are finite, but keep even a customized source tree bounded.
          if (legacyBytes + size > MAX_BYTES) { legacy.clear(); legacyBytes = 0; }
          if (size <= MAX_BYTES) { legacy.set(name, asset); legacyBytes += size; }
        }
      }
      if (!asset) return null;
      const encoding = staticEncoding(request.headers.get('accept-encoding') || '');
      const extra = { ...headers, 'Content-Type': asset.type, Vary: 'Accept-Encoding',
        'Cache-Control': asset.immutable ? 'private, max-age=31536000, immutable' : 'no-store' };
      if (!encoding) return new Response(null, { status: 406, headers: { ...extra, 'Cache-Control': 'no-store' } });
      if (encoding === 'gzip') extra['Content-Encoding'] = 'gzip';
      if (asset.immutable) {
        extra.ETag = asset.etags[encoding];
        // Firefox may revalidate fresh immutable resources on explicit HTTP reloads.
        // Authentication and encoding negotiation precede this conditional read.
        const validators = (request.headers.get('if-none-match') || '').split(',').map(value => value.trim().replace(/^W\//, ''));
        if (validators.includes('*') || validators.includes(extra.ETag)) return new Response(null, { status: 304, headers: extra });
      }
      return new Response(encoding === 'gzip' ? asset.gzip : asset.bytes, { headers: extra });
    },
  };
}

export function webStaticAssets() { return shared ||= createStaticAssets(); }
