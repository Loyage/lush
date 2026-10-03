// Structural Mach-O fixture only; never an executable Bun acceptance test.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BUN_VERSION, collectRuntimeSources, remoteSourceIdentity } from '../../scripts/build-remote.js';
export function macho(arch = 'arm64', dependency = '/usr/lib/libSystem.B.dylib', command = 0xc) {
  const offset = command === 0xe ? 12 : 24;
  const length = Math.ceil((offset + Buffer.byteLength(dependency) + 1) / 8) * 8;
  const bytes = Buffer.alloc(32 + length);
  bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(arch === 'arm64' ? 0x100000c : 0x1000007, 4);
  bytes.writeUInt32LE(2, 12); bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(length, 20);
  bytes.writeUInt32LE(command, 32); bytes.writeUInt32LE(length, 36); bytes.writeUInt32LE(offset, 40);
  bytes.write(dependency, 32 + offset);
  return bytes;
}
export function createLocalRuntime(root, directory, arch = 'arm64') {
  const sources = collectRuntimeSources(root), hashes = {};
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, bytes] of [...sources, ['bun', macho(arch)]]) {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { mode: name === 'bun' || name.startsWith('bin/') ? 0o755 : 0o644 });
    hashes[name] = createHash('sha256').update(bytes).digest('hex');
  }
  const metadata = { version: 1, target: `darwin-${arch}`, ...remoteSourceIdentity(root), bun_version: BUN_VERSION, files: hashes };
  fs.writeFileSync(path.join(directory, 'runtime.json'), JSON.stringify(metadata));
  return metadata;
}
