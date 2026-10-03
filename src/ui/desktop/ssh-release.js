import fs from 'node:fs';
import path from 'node:path';
import { BUN_VERSION, TARGETS, safePath, runtimeSourceIdentity, validateRemoteManifest, verifyPayloadDirectory } from './remote-artifact.js';
import { loadRemotePayload } from './ssh-payload.js';

const REPOSITORY = 'Loyage/lush';
const MAX_ARCHIVE = 256 * 1024 * 1024;
function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function check(value, message) { if (!value) throw failure('PAYLOAD_INVALID', message); }
function cancelled(signal) { if (signal?.aborted) throw failure('CANCELLED', '运行包下载已取消；不会上传或安装。'); }
function stat(file) { return fs.lstatSync(file, { throwIfNoEntry: false }); }
function directory(file) {
  const current = stat(file);
  check(current?.isDirectory() && !current.isSymbolicLink()
    && (typeof process.getuid !== 'function' || current.uid === process.getuid()), '运行包缓存目录不安全');
}

/** Source development identity uses portable paths; packaged apps use their sealed manifest instead. */
export function desktopReleaseIdentity(root) {
  const files = new Map();
  function walk(name) {
    const file = path.join(root, name), current = fs.lstatSync(file);
    check(!current.isSymbolicLink(), '客户端源码不能包含符号链接');
    if (current.isDirectory()) for (const child of fs.readdirSync(file)) walk(`${name}/${child}`);
    else { check(current.isFile(), '客户端源码类型无效'); files.set(name, fs.readFileSync(file)); }
  }
  for (const name of ['src', 'bin', 'package.json']) walk(name);
  return runtimeSourceIdentity(files);
}

/** Fixed publisher and identity only. resolve() is offline; download() is called after installation consent. */
export function createReleasePayloadProvider({ payloadDir, userData, identity, fetchImpl = globalThis.fetch } = {}) {
  check(identity && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(identity.lush_version)
    && /^[a-f0-9]{16}$/.test(identity.fingerprint), '缺少客户端运行包身份');
  identity = { lush_version: identity.lush_version, fingerprint: identity.fingerprint };
  check(typeof userData === 'string' && userData, '缺少运行包缓存位置');
  userData = safePath(userData);
  const tag = `payload-v${identity.lush_version}-${identity.fingerprint}`;
  const releaseURL = `https://github.com/${REPOSITORY}/releases/tag/${tag}`;
  const baseURL = `https://github.com/${REPOSITORY}/releases/download/${tag}/`;
  const cacheRoot = path.join(userData, 'payload-cache');
  const cacheIdentity = path.join(cacheRoot, tag);
  function sameIdentity(manifest) {
    return manifest.lush_version === identity.lush_version && manifest.fingerprint === identity.fingerprint;
  }
  function cached(target) {
    // Only client-owned descendants are writable. Preserve all existing files on failure.
    for (const file of [userData, cacheRoot, cacheIdentity, path.join(cacheIdentity, target)]) {
      if (!stat(file)) return null;
      directory(file);
    }
    return verified(path.join(cacheIdentity, target), target);
  }
  function verified(file, target) {
    if (!file || !stat(file)) return null;
    check(stat(file).isDirectory() && !stat(file).isSymbolicLink(), '远端运行包目录不安全');
    const manifest = verifyPayloadDirectory(file);
    // Old manually prepared packages are left intact; never install another checkout's runtime.
    if (!sameIdentity(manifest) || !manifest.targets[target]) return null;
    return loadRemotePayload(file, target);
  }
  function resolve(target) {
    check(TARGETS.includes(target), '不支持的远端架构');
    const payload = verified(payloadDir, target) || cached(target);
    if (payload) return payload;
    return { target, fingerprint: identity.fingerprint, lushVersion: identity.lush_version,
      bunVersion: BUN_VERSION, download: { repository: REPOSITORY, tag, releaseURL,
        file: `lush-remote-${target}.tar.gz`, maximumBytes: MAX_ARCHIVE } };
  }
  function allowedURL(value) {
    const url = new URL(value);
    check(url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && !url.hash && (url.hostname === 'github.com' && url.href.startsWith(baseURL)
        || ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)), '拒绝非可信 GitHub 运行包下载地址');
    return url.href;
  }
  async function request(url, maximum, signal) {
    cancelled(signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 120000); timer.unref?.();
    try {
      for (let redirects = 0; redirects <= 4; redirects++) {
        cancelled(signal);
        const response = await fetchImpl(allowedURL(url), { signal: controller.signal, redirect: 'manual',
          credentials: 'omit', headers: { Accept: 'application/octet-stream' } });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          check(location && redirects < 4, 'GitHub 下载重定向无效或过多');
          url = new URL(location, url).href; continue;
        }
        if (response.status !== 200) {
          await response.body?.cancel();
          throw failure('PAYLOAD_DOWNLOAD', response.status === 404
            ? `此客户端的运行包 Release 尚未发布或不可公开访问：${releaseURL}。请等待匹配的正式版本 tag 发布完成，开发时可手工导入可信同源码的 payload；不会使用最新或旧版本替代。`
            : `GitHub 运行包下载失败（HTTP ${response.status}）；未修改服务器，请检查网络或稍后重新确认。`);
        }
        const size = response.headers.get('content-length');
        if (size !== null && (!/^\d+$/.test(size) || Number(size) > maximum)) {
          await response.body?.cancel(); throw failure('PAYLOAD_INVALID', 'GitHub 运行包响应超过大小限制');
        }
        check(response.body, 'GitHub 运行包响应为空');
        const reader = response.body.getReader(), chunks = [];
        let length = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            cancelled(signal);
            if (done) break;
            length += value.byteLength;
            check(length <= maximum, 'GitHub 运行包响应超过大小限制');
            chunks.push(Buffer.from(value));
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        check(size === null || Number(size) === length, 'GitHub 运行包响应已截断');
        return Buffer.concat(chunks, length);
      }
    } catch (error) {
      cancelled(signal);
      if (error.code === 'PAYLOAD_INVALID' || error.code === 'PAYLOAD_DOWNLOAD') throw error;
      throw failure('PAYLOAD_DOWNLOAD', controller.signal.aborted
        ? 'GitHub 运行包下载超时；未修改服务器，请重新确认后重试。'
        : '无法下载 GitHub 运行包；未修改服务器，请检查网络或手工准备可信产物。');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async function download(target, { signal } = {}) {
    cancelled(signal);
    const known = resolve(target);
    if (!known.download) return known;
    // Metadata is trusted only through this fixed publisher, never from the SSH server or renderer.
    const manifest = validateRemoteManifest(JSON.parse((await request(`${baseURL}manifest.json`, 16384, signal)).toString('utf8')));
    check(sameIdentity(manifest), 'GitHub 运行包与客户端源码身份不匹配');
    check(manifest.targets[target], `GitHub Release 缺少 ${target} 运行包`);
    const entry = manifest.targets[target];
    const archive = await request(`${baseURL}${entry.file}`, MAX_ARCHIVE, signal);
    cancelled(signal);
    fs.mkdirSync(userData, { recursive: true, mode: 0o700 }); directory(userData);
    for (const file of [cacheRoot, cacheIdentity]) {
      if (!stat(file)) fs.mkdirSync(file, { mode: 0o700 });
      directory(file);
    }
    const temporary = fs.mkdtempSync(path.join(cacheIdentity, '.download-'));
    try {
      fs.writeFileSync(path.join(temporary, 'manifest.json'), JSON.stringify({ ...manifest, targets: { [target]: entry } }), { mode: 0o600, flag: 'wx' });
      fs.writeFileSync(path.join(temporary, entry.file), archive, { mode: 0o600, flag: 'wx' });
      // Includes archive/ELF/Bun/source fingerprint validation, without executing any Linux code locally.
      verified(temporary, target);
      cancelled(signal);
      const destination = path.join(cacheIdentity, target);
      if (stat(destination)) {
        const existing = cached(target);
        check(existing?.archiveSha256 === entry.sha256, '已有运行包缓存与下载产物不一致；不会覆盖');
        return existing;
      }
      fs.renameSync(temporary, destination);
      return cached(target);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  return { resolve, download };
}
