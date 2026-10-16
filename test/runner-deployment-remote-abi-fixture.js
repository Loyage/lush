import fs from 'node:fs';
import path from 'node:path';
export const officialAbi = () => ({ supported: true, reason: null, profile: 'official-linux-x64-baseline', format: 'elf64-le', machine: 'x86_64', interpreter: '/lib64/ld-linux-x86-64.so.2', libc: 'glibc', libc_min_version: '2.17', kernel_min_version: '3.10', cpu_features: ['sse4_2'], proof: 'pinned-github-release-sha256', probe_required: true, files: [], needed: ['ld-linux-x86-64.so.2', 'libc.so.6', 'libdl.so.2', 'libm.so.6', 'libpthread.so.0'] });
export const officialRuntime = () => ({ source: 'official-bun', version: '1.4.2', sha256: 'a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c', size: 79500640, os: 'linux', arch: 'x64' });
export function officialFixture(f) {
  const root = path.join(f.root, 'official'), bin = f.bin;
  fs.mkdirSync(root); fs.mkdirSync(path.join(root, 'lib64')); fs.mkdirSync(path.join(root, 'usr')); fs.mkdirSync(path.join(root, 'usr/lib'));
  const cpu = path.join(root, 'cpu'), cache = path.join(root, 'cache'), header = Buffer.from('7f454c4602010100000000000000000003003e00', 'hex');
  const loader = path.join(root, 'lib64/ld-linux-x86-64.so.2'); fs.writeFileSync(loader, header, { mode: 0o755 });
  const libs = officialAbi().needed.slice(1).map(name => path.join(root, 'usr/lib', name)); for (const file of libs) fs.writeFileSync(file, header, { mode: 0o755 });
  fs.writeFileSync(cpu, 'processor : 0\nflags : sse4_2\nprocessor : 1\nflags : sse4_2\n'); fs.writeFileSync(cache, 'fixture');
  const write = (name, source) => fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n' + source + '\n', { mode: 0o700 });
  write('getconf', 'echo "glibc 2.17"'); write('loader-version', 'echo "ld.so (GNU libc) stable release version 2.17."');
  write('uname', '[ "$1" != -r ] || { echo 3.10.0-fixture; exit 0; }; exec /usr/bin/uname "$@"');
  write('ldconfig', "printf '%s\\n' " + libs.map((file, i) => `'${officialAbi().needed[i + 1]} (libc6,x86-64) => ${file}'`).join(' '));
  write('stat', `case "$*" in *'${root}'*) case "$*" in *"%u"*) echo 0; exit 0;; esac;; esac\nexec /usr/bin/stat "$@"`);
  const rewrite = script => script.replaceAll('/lib64/', root + '/lib64/').replaceAll('/usr/lib/', root + '/usr/lib/').replaceAll('/proc/cpuinfo', cpu).replaceAll('/etc/ld.so.cache', cache).replaceAll('/usr/sbin/ldconfig', bin + '/ldconfig').replaceAll(loader + ' --version', bin + '/loader-version --version');
  f.hook(() => ({ rewrite })); return { root, libs, loader, cpu, write, rewrite };
}
