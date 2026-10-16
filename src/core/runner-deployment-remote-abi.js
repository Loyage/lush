import fs from 'node:fs';
import path from 'node:path';
import { check } from './types.js';

// Reviewed profile, independent of the packaging implementation. Changes require
// a new audited profile/pin, not an automatic version/provenance fallback.
const official = () => ({ supported: true, reason: null, profile: 'official-linux-x64-baseline', format: 'elf64-le', machine: 'x86_64', interpreter: '/lib64/ld-linux-x86-64.so.2', libc: 'glibc', libc_min_version: '2.17', kernel_min_version: '3.10', cpu_features: ['sse4_2'], proof: 'pinned-github-release-sha256', probe_required: true, files: [], needed: ['ld-linux-x86-64.so.2', 'libc.so.6', 'libdl.so.2', 'libm.so.6', 'libpthread.so.0'] });
export function deploymentAbiEvidence(abi) {
  check(abi && typeof abi === 'object' && abi.supported !== false, 'Verified deployment ABI evidence is required');
  if (abi.profile !== undefined) {
    const expected = official();
    check(Object.keys(abi).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => JSON.stringify(abi[key]) === JSON.stringify(value)), 'Unsupported deployment ABI profile');
    return expected;
  }
  check(abi.kind === undefined || abi.kind === 'central-files-v1', 'Unsupported deployment ABI schema');
  check(Array.isArray(abi.files) && abi.files.length > 0 && abi.files.length <= 64, 'Verified deployment ABI evidence is required');
  const absolute = value => typeof value === 'string' && /^\/[A-Za-z0-9_./+-]+$/.test(value) && value !== '/' && path.posix.normalize(value) === value && !value.split('/').includes('..');
  const files = abi.files.map(row => {
    check(row && absolute(row.path) && absolute(row.realpath) && /^\/(?:nix\/store|lib(?:32|64)?|usr\/lib(?:32|64)?)(?:\/|$)/.test(row.path) && /^[a-f0-9]{64}$/.test(row.sha256) && Number.isSafeInteger(row.size) && row.size > 0 && row.size <= 512 * 1024 * 1024, 'Invalid deployment ABI evidence');
    return { path: row.path, realpath: row.realpath, sha256: row.sha256, size: row.size };
  });
  check(new Set(files.map(row => row.path)).size === files.length && files.reduce((sum, row) => sum + row.size, 0) <= 512 * 1024 * 1024, 'Duplicate or oversized deployment ABI evidence');
  const cpu = abi.cpu_features ?? [...new Set([...fs.readFileSync('/proc/cpuinfo', 'utf8').matchAll(/^(?:flags|Features)\s*:\s*(.*)$/gm)].flatMap(match => match[1].trim().toLowerCase().split(/\s+/)))];
  check(Array.isArray(cpu) && cpu.length > 0 && cpu.length <= 512 && cpu.every(flag => typeof flag === 'string' && /^[a-z0-9_]{1,64}$/.test(flag)), 'Deployment CPU evidence is required');
  return { ...(abi.kind ? { kind: abi.kind } : {}), files, cpu_features: [...new Set(cpu)].sort() };
}
export const validateDeploymentAbi = abi => deploymentAbiEvidence(abi).files;
export function reviewedDeploymentRuntime(runtime, abi) {
  return abi.profile ? runtime?.source === 'official-bun' && runtime.version === '1.4.2' && runtime.sha256 === 'a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c' && runtime.size === 79500640 && (runtime.os === undefined || runtime.os === 'linux') && (runtime.arch === undefined || runtime.arch === 'x64') : runtime?.source === undefined || runtime.source === 'central-bun';
}

// Self-contained: serialized with the verifier. Output is only readiness and a
// private observed-library digest. No library path/stdout diagnostic is public.
export function deploymentAbiScript(abi) {
  const q = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
  const cpu = `awk -v required=${q(abi.cpu_features.join(' '))} 'BEGIN { n=split(required,want," "); count=0; ok=1 } /^[[:space:]]*(flags|Features)[[:space:]]*:/ { count++; sub(/^[^:]*:[[:space:]]*/, ""); line=" " tolower($0) " "; for(i=1;i<=n;i++) if(index(line," " want[i] " ")==0) ok=0 } END { exit !(ok && count>0) }' /proc/cpuinfo`;
  if (!abi.profile) return `abi_ready=1; abi_observed_sha256=''
${cpu} || abi_ready=0
${abi.files.map(row => `[ -f ${q(row.path)} ] && [ "$(stat -Lc '%u' -- ${q(row.path)})" = 0 ] && [ "$(readlink -f -- ${q(row.path)})" = ${q(row.realpath)} ] && [ "$(stat -Lc '%s' -- ${q(row.path)})" = ${q(row.size)} ] && [ "$(sha256sum -- ${q(row.path)} | cut -d ' ' -f 1)" = ${q(row.sha256)} ] || abi_ready=0
case "$(stat -Lc '%a' -- ${q(row.path)})" in [4567][0145][0145]) ;; *) abi_ready=0;; esac`).join('\n')}`;
  if (abi.profile !== 'official-linux-x64-baseline') throw new Error('Unsupported deployment ABI profile');
  return `abi_ready=0; abi_observed_sha256=''
abi_observed_sha256=$( (
set -eu
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ]
${cpu}
abi_trusted() {
  [ -f "$1" ] && [ "$(stat -Lc '%u' -- "$1")" = 0 ]
  case "$(stat -Lc '%a' -- "$1")" in [4567][0145][0145]) ;; *) return 1;; esac
  abi_header=$(od -An -tx1 -N20 -- "$1" | tr -d ' \\n')
  [ "$(printf '%s' "$abi_header" | cut -c1-14)" = 7f454c46020101 ] && [ "$(printf '%s' "$abi_header" | cut -c37-40)" = 3e00 ]
}
abi_trusted /lib64/ld-linux-x86-64.so.2
abi_glibc=$(getconf GNU_LIBC_VERSION)
printf '%s\\n' "$abi_glibc" | awk '$1=="glibc" && $2 ~ /^[0-9]+[.][0-9]+$/ {split($2,a,"."); if(a[1]>2 || (a[1]==2 && a[2]>=17)) ok=1} END {exit !ok}'
abi_loader=$(/lib64/ld-linux-x86-64.so.2 --version | sed -n 's/.*stable release version \\([0-9][0-9]*\\.[0-9][0-9]*\\).*/\\1/p' | head -n 1)
[ "$abi_glibc" = "glibc $abi_loader" ]
abi_kernel=$(uname -r)
printf '%s\\n' "$abi_kernel" | awk '{split($0,a,"."); if(a[1] ~ /^[0-9]+$/ && a[2] ~ /^[0-9]+$/ && (a[1]>3 || (a[1]==3 && a[2]>=10))) ok=1} END {exit !ok}'
[ -f /etc/ld.so.cache ] && [ "$(stat -Lc '%s' /etc/ld.so.cache)" -le 8388608 ]
abi_cache=$( (set +e; /usr/sbin/ldconfig -p 2>/dev/null; printf '\\nLCM_RC=%s\\n' "$?") | head -c 1048577)
[ "\${#abi_cache}" -le 1048576 ] && [ "$(printf '%s\\n' "$abi_cache" | tail -n 1)" = LCM_RC=0 ]
abi_facts=$(for abi_name in ld-linux-x86-64.so.2 libc.so.6 libdl.so.2 libm.so.6 libpthread.so.0; do
  if [ "$abi_name" = ld-linux-x86-64.so.2 ]; then abi_path=/lib64/ld-linux-x86-64.so.2; else abi_path=$(printf '%s\\n' "$abi_cache" | awk -v n="$abi_name" '$1==n && $0 ~ /x86-64/ && $(NF-1)=="=>" {print $NF; exit}'); fi
  case "$abi_path" in /lib/*|/lib64/*|/usr/lib/*|/usr/lib64/*|/nix/store/*) ;; *) exit 41;; esac
  abi_trusted "$abi_path" || exit 41
  printf '%s:%s:%s:%s\\n' "$abi_name" "$(readlink -f -- "$abi_path")" "$(stat -Lc '%u:%a:%s:%d:%i' -- "$abi_path")" "$(sha256sum -- "$abi_path" | cut -d ' ' -f 1)"
done)
printf '%s\\n%s\\n%s\\n' "$abi_glibc" "$abi_kernel" "$abi_facts" | sha256sum | cut -d ' ' -f 1
) 2>/dev/null) || abi_observed_sha256=''
case "$abi_observed_sha256" in ''|*[!a-f0-9]*) ;; *) [ "\${#abi_observed_sha256}" = 64 ] && abi_ready=1;; esac
`;
}
