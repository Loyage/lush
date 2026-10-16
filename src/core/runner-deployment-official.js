import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { posixFiles } from './workspaces/code-posix.js';
import { digest, failure, fdPath, requireArtifact, signature } from './runner-deployment-package.js';

// Audited public release, not latest. The archive hash is GitHub's asset digest; the binary hash
// is derived from that verified archive. Updating the central Bun requires a new reviewed pin.
export const OFFICIAL_BUN = Object.freeze({
  version: '1.4.2', os: 'linux', arch: 'x64', asset: 'bun-linux-x64-baseline', asset_id: 545309055,
  url: 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64-baseline.zip',
  digest_url: 'https://api.github.com/repos/oven-sh/bun/releases/assets/545309055',
  documentation: 'https://raw.githubusercontent.com/oven-sh/bun/744846f844374847c902b5e7fd59b4342a51ef99/docs/installation.mdx',
  archive_size: 36646949, archive_sha256: 'c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f',
  size: 79500640, sha256: 'a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c',
});
export const officialAbi = () => ({ supported: true, reason: null, profile: 'official-linux-x64-baseline',
  format: 'elf64-le', machine: 'x86_64', interpreter: '/lib64/ld-linux-x86-64.so.2',
  libc: 'glibc', libc_min_version: '2.17', kernel_min_version: '3.10', cpu_features: ['sse4_2'],
  proof: 'pinned-github-release-sha256', probe_required: true, files: [],
  needed: ['ld-linux-x86-64.so.2', 'libc.so.6', 'libdl.so.2', 'libm.so.6', 'libpthread.so.0'] });
const unavailable = () => Object.assign(failure('UNSUPPORTED'), { reason: 'official_runtime_unavailable' });
const cacheName = pin => `${pin.archive_sha256}.zip`;
const inode = stat => `${stat.dev}:${stat.ino}`;
function archiveValid(data, pin) {
  requireArtifact(data.length === pin.archive_size && data.length <= 64 * 1024 * 1024 && digest(data) === pin.archive_sha256);
}
export function decodeOfficialZip(data, pin = OFFICIAL_BUN) {
  archiveValid(data, pin);
  const end = data.length - 22; requireArtifact(end >= 0 && data.readUInt32LE(end) === 0x06054b50
    && data.readUInt16LE(end + 4) === 0 && data.readUInt16LE(end + 6) === 0
    && data.readUInt16LE(end + 8) === 2 && data.readUInt16LE(end + 10) === 2 && data.readUInt16LE(end + 20) === 0);
  const start = data.readUInt32LE(end + 16); requireArtifact(start + data.readUInt32LE(end + 12) === end);
  let at = start, nextLocal = 0, binary;
  for (let index = 0; index < 2; index++) {
    requireArtifact(at + 46 <= end && data.readUInt32LE(at) === 0x02014b50);
    const flags = data.readUInt16LE(at + 8), method = data.readUInt16LE(at + 10), crc = data.readUInt32LE(at + 16);
    const compressed = data.readUInt32LE(at + 20), size = data.readUInt32LE(at + 24), n = data.readUInt16LE(at + 28), extra = data.readUInt16LE(at + 30), comment = data.readUInt16LE(at + 32);
    const type = (data.readUInt32LE(at + 38) >>> 16) & 0xf000, local = data.readUInt32LE(at + 42);
    requireArtifact(n <= 100 && extra <= 256 && comment === 0 && at + 46 + n + extra <= end && local === nextLocal && local + 30 <= start);
    const name = data.subarray(at + 46, at + 46 + n).toString('utf8');
    requireArtifact(name === `${pin.asset}/${index ? 'bun' : ''}` && type === (index ? 0x8000 : 0x4000)
      && data.readUInt32LE(local) === 0x04034b50 && data.readUInt16LE(local + 6) === flags && data.readUInt16LE(local + 8) === method);
    const localName = data.readUInt16LE(local + 26), localExtra = data.readUInt16LE(local + 28), body = local + 30 + localName + localExtra;
    requireArtifact(localName === n && localExtra <= 256 && body + compressed <= start && data.subarray(local + 30, local + 30 + n).toString('utf8') === name);
    if (!index) requireArtifact(flags === 0 && method === 0 && size === 0 && compressed === 0);
    else {
      requireArtifact(flags === 8 && method === 8 && size === pin.size && size <= 256 * 1024 * 1024 && compressed > 0
        && body + compressed + 16 === start && data.readUInt32LE(body + compressed) === 0x08074b50
        && data.readUInt32LE(body + compressed + 4) === crc && data.readUInt32LE(body + compressed + 8) === compressed
        && data.readUInt32LE(body + compressed + 12) === size);
      binary = inflateRawSync(data.subarray(body, body + compressed), { maxOutputLength: size });
      requireArtifact(binary.length === size && digest(binary) === pin.sha256);
    }
    nextLocal = body + compressed + (index ? 16 : 0); at += 46 + n + extra;
  }
  requireArtifact(at === end && binary); return binary;
}
// Internal test seams only; production uses the fixed pin and native fetch, never JSON URLs/digests.
export async function downloadOfficialZip(request = fetch, pin = OFFICIAL_BUN) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000); timer.unref?.();
  let reader, response;
  try {
    let url = pin.url;
    for (let redirects = 0; redirects <= 2; redirects++) {
      response = await request(url, { redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: { 'accept-encoding': 'identity' }, signal: controller.signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const next = new URL(response.headers.get('location'), url);
        requireArtifact(redirects < 2 && next.protocol === 'https:' && !next.username && !next.password && !next.port && !next.hash
          && ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(next.hostname));
        url = next.href; continue;
      }
      requireArtifact(response.status === 200 && response.body && (!response.headers.get('content-encoding') || response.headers.get('content-encoding') === 'identity')
        && (!response.headers.get('content-length') || response.headers.get('content-length') === String(pin.archive_size)));
      reader = response.body.getReader(); const chunks = []; let size = 0;
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength; requireArtifact(size <= pin.archive_size && size <= 64 * 1024 * 1024); chunks.push(Buffer.from(value));
      }
      const data = Buffer.concat(chunks, size); archiveValid(data, pin); return data;
    }
    throw unavailable();
  } catch (error) { if (error?.code === 'INVALID_ARTIFACT') throw failure(); throw unavailable(); }
  finally { controller.abort(); try { if (reader) await reader.cancel(); else await response?.body?.cancel(); } catch {} clearTimeout(timer); }
}
function checkCache(fd) {
  const stat = fs.fstatSync(fd, { bigint: true });
  requireArtifact(stat.isDirectory() && stat.uid === BigInt(process.getuid()) && (stat.mode & 0o777n) === 0o700n); return inode(stat);
}
function readCached(base, pin) {
  let fd;
  try { fd = posixFiles.openAt(base, cacheName(pin)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    requireArtifact(before.isFile() && before.nlink === 1n && before.uid === BigInt(process.getuid()) && (before.mode & 0o777n) === 0o600n
      && before.size === BigInt(pin.archive_size) && before.size <= 64n * 1024n * 1024n);
    const data = Buffer.alloc(Number(before.size) + 1); let size = 0, count;
    while (size < data.length && (count = fs.readSync(fd, data, size, data.length - size, null))) size += count;
    requireArtifact(size === Number(before.size) && signature(before) === signature(fs.fstatSync(fd, { bigint: true })));
    const named = posixFiles.openAt(base, cacheName(pin));
    try { requireArtifact(signature(before) === signature(fs.fstatSync(named, { bigint: true }))); } finally { fs.closeSync(named); }
    const result = data.subarray(0, size); archiveValid(result, pin); return result;
  } finally { fs.closeSync(fd); }
}
function publishCache(base, data, pin) {
  const temporary = `${fdPath(base)}/.official-${randomUUID()}.zip`, target = `${fdPath(base)}/${cacheName(pin)}`;
  const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | fs.constants.O_RDWR, 0o600);
  const own = inode(fs.fstatSync(fd, { bigint: true }));
  try {
    fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, data); fs.fsyncSync(fd);
    try { fs.linkSync(temporary, target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally {
    fs.closeSync(fd);
    const stat = fs.lstatSync(temporary, { bigint: true }); requireArtifact(stat.isFile() && inode(stat) === own); fs.unlinkSync(temporary);
  }
}
export async function obtainOfficialRuntime({ cache_directory, allow_download = false } = {}, request = fetch, pin = OFFICIAL_BUN) {
  let base, identity;
  try {
    requireArtifact(typeof allow_download === 'boolean');
    if (cache_directory !== undefined) {
      requireArtifact(typeof cache_directory === 'string' && path.isAbsolute(cache_directory) && path.normalize(cache_directory) === cache_directory);
      base = posixFiles.openDirectory(cache_directory); identity = checkCache(base);
    }
    let data = base === undefined ? null : readCached(base, pin);
    if (!data) {
      if (!allow_download) throw unavailable();
      data = await downloadOfficialZip(request, pin);
      if (base !== undefined) { publishCache(base, data, pin); data = readCached(base, pin); }
    }
    if (base !== undefined) {
      const named = posixFiles.openDirectory(cache_directory);
      try { requireArtifact(checkCache(named) === identity); } finally { fs.closeSync(named); }
    }
    return decodeOfficialZip(data, pin);
  } catch (error) { throw error?.code === 'UNSUPPORTED' ? unavailable() : failure(); }
  finally { if (base !== undefined) fs.closeSync(base); }
}
