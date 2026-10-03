import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const SHA = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const MAX_ARCHIVE = 256 * 1024 * 1024;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function check(value, message) { if (!value) throw new Error(message); }
function regular(file, maximum) {
  const stat = fs.lstatSync(file);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum, '远端安装产物不是安全的普通文件或超过大小限制');
  return fs.readFileSync(file);
}

/** Only reviewed regular files/directories, never links, devices or escaping archive paths. */
export function readRemoteTar(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: MAX_ARCHIVE });
  const files = new Map();
  let offset = 0, ended = false;
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every(byte => byte === 0)) { ended = true; break; }
    const text = (start, size) => block.subarray(start, start + size).toString('utf8').replace(/\0.*$/s, '');
    const octal = value => { check(/^[0-7]+$/.test(value.trim()), '远端归档数字字段无效'); return Number.parseInt(value.trim(), 8); };
    const expected = octal(text(148, 8));
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i];
    check(sum === expected, '远端归档头校验失败');
    const prefix = text(345, 155);
    let name = `${prefix ? `${prefix}/` : ''}${text(0, 100)}`.replace(/^\.\//, '').replace(/\/$/, '');
    const kind = text(156, 1), size = octal(text(124, 12));
    check((kind === '' || kind === '0' || kind === '5') && (kind !== '5' || size === 0), '远端归档不允许链接、设备或扩展头');
    check(name && !name.startsWith('/') && !name.includes('\\') && !/[\x00-\x1f\x7f]/.test(name)
      && name.split('/').every(part => part && part !== '.' && part !== '..'), '远端归档包含不安全路径');
    check(['src', 'bin', 'docs'].includes(name.split('/')[0]) || ['bun', 'README.md', 'package.json', 'remote.json'].includes(name), '远端归档含未授权的文件');
    check(!files.has(name), '远端归档包含重复路径');
    check(offset + 512 + size <= tar.length, '远端归档已截断');
    files.set(name, { kind, bytes: tar.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  check(ended && tar.subarray(offset).every(byte => byte === 0), '远端归档尾部无效');
  for (const name of files.keys()) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = files.get(parts.slice(0, i).join('/'));
      check(!parent || parent.kind === '5', '远端归档文件与目录路径冲突');
    }
  }
  return files;
}

/** The manifest is supplied by the trusted installed client, not fetched from the remote machine. */
export function loadRemotePayload(payloadDir, target) {
  try {
    check(['linux-x64', 'linux-arm64'].includes(target), '首期 SSH 自动部署只支持 Linux x64 / ARM64');
    check(payloadDir && fs.lstatSync(payloadDir).isDirectory() && !fs.lstatSync(payloadDir).isSymbolicLink(), '缺少远端运行包');
    const manifest = JSON.parse(regular(path.join(payloadDir, 'manifest.json'), 32 * 1024).toString());
    check(object(manifest) && manifest.version === 1 && VERSION.test(manifest.lush_version)
      && /^[a-f0-9]{16}$/.test(manifest.fingerprint) && object(manifest.targets), '远端产物 manifest 无效');
    const row = manifest.targets[target];
    check(object(row), `缺少 ${target} 远端运行包`);
    check(typeof row.file === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz$/.test(row.file)
      && SHA.test(row.sha256) && SHA.test(row.bun_sha256) && VERSION.test(row.bun_version), '远端产物 manifest 字段无效');
    const archive = regular(path.join(payloadDir, row.file), MAX_ARCHIVE);
    check(digest(archive) === row.sha256, '远端运行包 SHA-256 校验失败');
    const files = readRemoteTar(archive);
    const entry = name => { const value = files.get(name); check(value && value.kind !== '5', `远端运行包缺少 ${name}`); return value.bytes; };
    const metadata = JSON.parse(entry('remote.json').toString());
    check(object(metadata) && metadata.version === 1 && metadata.target === target && metadata.fingerprint === manifest.fingerprint
      && metadata.lush_version === manifest.lush_version && metadata.bun_version === row.bun_version
      && metadata.bun_sha256 === row.bun_sha256, '远端运行包身份与 manifest 不匹配');
    check(digest(entry('bun')) === row.bun_sha256, '私有 Bun SHA-256 校验失败');
    for (const name of ['bin/lush', 'bin/lush-host', 'bin/lush-host-worker', 'bin/lushd', 'src/identity.js']) entry(name);
    const pkg = JSON.parse(entry('package.json').toString());
    check(pkg.version === manifest.lush_version && pkg.type === 'module', '远端运行包 package.json 无效');
    return { target, fingerprint: manifest.fingerprint, lushVersion: manifest.lush_version, bunVersion: row.bun_version,
      bunSha256: row.bun_sha256, archiveSha256: row.sha256, archive, file: row.file };
  } catch (error) {
    const failure = new Error(`无法使用可信远端运行包：${error.message}。请构建 remote payload 或安装含目标架构产物的客户端。`);
    failure.code = 'PAYLOAD_INVALID';
    throw failure;
  }
}
