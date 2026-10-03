// Static ELF/tar fixtures only; these are never treated as executable Bun acceptance tests.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { BUN_VERSION, TARGETS, remoteSourceIdentity } from '../../scripts/build-remote.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function entry(name, content = Buffer.alloc(0), directory = false) {
  const header = Buffer.alloc(512), bytes = Buffer.from(content);
  header.write(name, 0, 100);
  const octal = (start, length, value) => header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, start, length);
  octal(100, 8, directory || name === 'bun' || name.startsWith('bin/') ? 0o755 : 0o644);
  octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, bytes.length); octal(136, 12, 0);
  header.fill(32, 148, 156); header.write(directory ? '5' : '0', 156);
  header.write('ustar\0', 257); header.write('00', 263);
  header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([header, bytes, Buffer.alloc(Math.ceil(bytes.length / 512) * 512 - bytes.length)]);
}
function elf(target) {
  const bytes = Buffer.alloc(120);
  bytes.set([127, 69, 76, 70, 2, 1, 1]);
  bytes.writeUInt16LE(2, 16); bytes.writeUInt16LE(target === 'linux-x64' ? 62 : 183, 18);
  bytes.writeBigUInt64LE(64n, 32); bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(1, 56);
  bytes.writeUInt32LE(1, 64); bytes.writeBigUInt64LE(120n, 96);
  return bytes;
}
export function createRemotePayload(root, directory, targets = TARGETS) {
  for (const dir of ['src', 'bin', 'docs']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const name of ['src/identity.js', 'README.md', 'docs/README.md', 'bin/lush', 'bin/lush-host', 'bin/lushd']) {
    if (!fs.existsSync(path.join(root, name))) fs.writeFileSync(path.join(root, name), name.endsWith('.md') ? '# Fixture\n' : '// fixture\n');
  }
  if (!fs.existsSync(path.join(root, 'package.json'))) fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.2.0', type: 'module' }));
  const identity = remoteSourceIdentity(root);
  const sources = [];
  function walk(name) {
    const file = path.join(root, name);
    if (fs.statSync(file).isDirectory()) {
      sources.push(entry(`${name}/`, Buffer.alloc(0), true));
      for (const child of fs.readdirSync(file).sort()) walk(`${name}/${child}`);
    } else sources.push(entry(name, fs.readFileSync(file)));
  }
  for (const name of ['src', 'bin', 'docs', 'README.md', 'package.json']) walk(name);
  const manifest = { version: 1, ...identity, targets: {} };
  fs.mkdirSync(directory, { recursive: true });
  for (const target of targets) {
    const bun = elf(target), bun_sha256 = hash(bun);
    const metadata = { version: 1, target, ...identity, bun_version: BUN_VERSION, bun_sha256 };
    const archive = gzipSync(Buffer.concat([...sources, entry('bun', bun), entry('remote.json', JSON.stringify(metadata)), Buffer.alloc(1024)]));
    const file = `lush-remote-${target}.tar.gz`;
    fs.writeFileSync(path.join(directory, file), archive);
    manifest.targets[target] = { file, sha256: hash(archive), bun_version: BUN_VERSION, bun_sha256 };
  }
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}
