// These scripts are fixed client code. User values are validated by ssh.js, then shell-quoted.
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const COMMON = `set -eu
umask 077
die() { printf 'LUSH_SSH_ERROR %s\\n' "$1"; exit 70; }
[ -n "\${HOME:-}" ] && [ "\${HOME#/}" != "$HOME" ] || die UNSAFE_HOME
safe_dir() {
  [ ! -L "$1" ] || die UNSAFE_DIRECTORY
  if [ -e "$1" ]; then
    [ -d "$1" ] && [ "$(stat -c %u "$1")" = "$(id -u)" ] || die UNSAFE_DIRECTORY
  else
    mkdir -m 700 "$1" || die DIRECTORY_CREATE
  fi
}
prepare_base() {
  safe_dir "$HOME"
  safe_dir "$HOME/.local"
  safe_dir "$HOME/.local/share"
  safe_dir "$HOME/.local/share/lush"
  safe_dir "$HOME/.local/share/lush/remote"
  base="$HOME/.local/share/lush/remote"
  safe_dir "$base/versions"
  safe_dir "$base/profiles"
  safe_dir "$base/uploads"
}
`;

export function probeScript(payload) {
  const versionName = payload ? `${payload.fingerprint}-${payload.target}` : 'not-installed';
  return `# lush-ssh:probe
${COMMON}
[ "$(uname -s)" = Linux ] || die UNSUPPORTED_PLATFORM
for tool in base64 stat id uname head tr; do command -v "$tool" >/dev/null 2>&1 || die MISSING_TOOLS; done
field() { printf '%s\\t' "$1"; printf '%s' "$2" | base64 | tr -d '\\n'; printf '\\n'; }
root="$HOME/.local/share/lush/remote/versions/"${shellQuote(versionName)}
bun_path=$(command -v bun 2>/dev/null || true)
bun_version=''
if [ -n "$bun_path" ]; then bun_version=$("$bun_path" --version 2>/dev/null || true); fi
identity=''
if [ -f /etc/machine-id ]; then identity=$(head -c 128 /etc/machine-id); fi
[ -n "$identity" ] || identity=$(uname -n)
metadata=''
bun_sha=''
root_exists=0
if [ -e "$root" ] || [ -L "$root" ]; then
  root_exists=1
  [ ! -L "$root" ] && [ -d "$root" ] && [ "$(stat -c %u "$root")" = "$(id -u)" ] || die UNSAFE_DIRECTORY
  if [ -f "$root/remote.json" ] && [ ! -L "$root/remote.json" ]; then metadata=$(head -c 32769 "$root/remote.json"); fi
  if [ -f "$root/bun" ] && [ ! -L "$root/bun" ] && command -v sha256sum >/dev/null 2>&1; then bun_sha=$(sha256sum "$root/bun"); bun_sha=\${bun_sha%% *}; fi
fi
printf 'LUSH_SSH_PROBE\\n'
field os "$(uname -s)"
field arch "$(uname -m)"
field home "$HOME"
field uid "$(id -u)"
field identity "$identity"
field bun_path "$bun_path"
field bun_version "$bun_version"
field git "$(command -v git 2>/dev/null || true)"
field pi "$(command -v pi 2>/dev/null || true)"
field codex "$(command -v codex 2>/dev/null || true)"
field tar "$(command -v tar 2>/dev/null || true)"
field sha256sum "$(command -v sha256sum 2>/dev/null || true)"
field metadata "$metadata"
field installed_bun_sha "$bun_sha"
field root_exists "$root_exists"
`;
}

export function uploadScript(upload) {
  return `# lush-ssh:upload
${COMMON}
prepare_base
file="$base/uploads/"${shellQuote(upload)}
[ ! -e "$file" ] && [ ! -L "$file" ] || die UPLOAD_EXISTS
(set -C; cat > "$file") || die UPLOAD_FAILED
printf 'LUSH_SSH_UPLOADED\\n'
`;
}

// Executed only after the bundled Bun hash has been verified; no network or npm installation.
const VERIFY = `
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, fingerprint, target, version, bunVersion, bunSha] = process.argv.slice(1);
const m = JSON.parse(fs.readFileSync(path.join(root, 'remote.json'), 'utf8'));
if (m.version !== 1 || m.fingerprint !== fingerprint || m.target !== target || m.lush_version !== version || m.bun_version !== bunVersion || m.bun_sha256 !== bunSha) throw new Error('metadata mismatch');
const { codeIdentity } = await import(pathToFileURL(path.join(root, 'src/identity.js')));
if (codeIdentity().fingerprint !== fingerprint) throw new Error('source fingerprint mismatch');
`;

export function installScript(payload, upload) {
  const name = `${payload.fingerprint}-${payload.target}`;
  return `# lush-ssh:install
${COMMON}
prepare_base
file="$base/uploads/"${shellQuote(upload)}
[ -f "$file" ] && [ ! -L "$file" ] && [ "$(stat -c %u "$file")" = "$(id -u)" ] || die UNSAFE_UPLOAD
sum=$(sha256sum "$file"); sum=\${sum%% *}
[ "$sum" = ${shellQuote(payload.archiveSha256)} ] || die ARCHIVE_HASH
root="$base/versions/"${shellQuote(name)}
lock="$base/versions/.lock-"${shellQuote(name)}
[ ! -L "$lock" ] && mkdir -m 700 "$lock" 2>/dev/null || die INSTALL_BUSY
stage=''
cleanup() { [ -z "$stage" ] || rm -rf -- "$stage"; rmdir "$lock" 2>/dev/null || true; }
trap cleanup EXIT
trap 'cleanup; exit 71' HUP INT TERM
if [ ! -e "$root" ] && [ ! -L "$root" ]; then
  stage=$(mktemp -d "$base/versions/.install-XXXXXXXX") || die INSTALL_STAGE
  tar --no-same-owner --no-same-permissions -xzf "$file" -C "$stage" || die EXTRACT_FAILED
  [ -f "$stage/bun" ] && [ ! -L "$stage/bun" ] || die PRIVATE_BUN
  sum=$(sha256sum "$stage/bun"); sum=\${sum%% *}
  [ "$sum" = ${shellQuote(payload.bunSha256)} ] || die BUN_HASH
  chmod 700 "$stage/bun"
  [ "$("$stage/bun" --version)" = ${shellQuote(payload.bunVersion)} ] || die BUN_VERSION
  "$stage/bun" -e ${shellQuote(VERIFY)} "$stage" ${shellQuote(payload.fingerprint)} ${shellQuote(payload.target)} ${shellQuote(payload.lushVersion)} ${shellQuote(payload.bunVersion)} ${shellQuote(payload.bunSha256)} || die PACKAGE_IDENTITY
  mv -T -- "$stage" "$root" || die INSTALL_COMMIT
  stage=''
else
  [ ! -L "$root" ] && [ -d "$root" ] && [ "$(stat -c %u "$root")" = "$(id -u)" ] || die UNSAFE_DIRECTORY
  [ -f "$root/bun" ] && [ ! -L "$root/bun" ] || die PRIVATE_BUN
  sum=$(sha256sum "$root/bun"); sum=\${sum%% *}
  [ "$sum" = ${shellQuote(payload.bunSha256)} ] || die BUN_HASH
  "$root/bun" -e ${shellQuote(VERIFY)} "$root" ${shellQuote(payload.fingerprint)} ${shellQuote(payload.target)} ${shellQuote(payload.lushVersion)} ${shellQuote(payload.bunVersion)} ${shellQuote(payload.bunSha256)} || die PACKAGE_IDENTITY
fi
rm -- "$file"
printf 'LUSH_SSH_INSTALLED\\n'
`;
}

const HOST = `
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import cp from 'node:child_process';
const [root, profile, origin, fingerprint] = process.argv.slice(1);
const { codeIdentity } = await import(pathToFileURL(path.join(root, 'src/identity.js')));
if (codeIdentity().fingerprint !== fingerprint) throw new Error('source fingerprint mismatch');
const bindingFile = path.join(profile, 'ssh-binding.json');
const binding = {version: 1, root, origin, fingerprint};
if (fs.existsSync(path.join(profile, 'web.json'))) throw new Error('managed SSH Host cannot use public auth config');
if (fs.existsSync(bindingFile)) {
  if (fs.lstatSync(bindingFile).isSymbolicLink()) throw new Error('unsafe profile binding');
  const previous = JSON.parse(fs.readFileSync(bindingFile, 'utf8'));
  if (JSON.stringify(previous) !== JSON.stringify(binding)) throw new Error('existing Host binding differs; do not restart automatically');
} else {
  if (fs.existsSync(path.join(profile, 'host.state.json'))) throw new Error('unbound existing Host state');
  fs.writeFileSync(bindingFile, JSON.stringify(binding), {mode: 0o600, flag: 'wx'});
}
const { liveWebState } = await import(pathToFileURL(path.join(root, 'src/host/control.js')));
const existing = liveWebState({home: profile});
if (existing && (existing.fingerprint !== fingerprint || path.resolve(existing.code_dir) !== path.resolve(root))) throw new Error('existing Host version differs; do not restart automatically');
const env = {...process.env, LUSH_GLOBAL_CONFIG: profile, LUSH_WEB_SSH_ORIGIN: origin};
for (const key of ['LUSH_PROJECT', 'LUSH_HOME', 'LUSH_TASK_ID', 'LUSH_AGENT_TOKEN', 'LUSH_WEB_EPHEMERAL', 'LUSH_WEB_LAUNCHER']) delete env[key];
const result = cp.spawnSync(process.execPath, [path.join(root, 'bin/lush'), existing ? 'host-status' : 'host', ...(existing ? [] : ['0']), '--json'], {cwd: root, env, encoding:'utf8', timeout: 20000, maxBuffer: 128 * 1024});
if (result.error || result.status !== 0) throw new Error('Host start/status failed; inspect remote profile host.log');
const report = JSON.parse(result.stdout);
if (!report.running || report.code_match !== true || report.current_code?.fingerprint !== fingerprint || !Number.isSafeInteger(report.port) || report.port < 1 || report.port > 65535 || !Number.isSafeInteger(report.pid) || report.pid < 1 || report.url !== 'http://127.0.0.1:' + report.port) throw new Error('unexpected Host identity or listener');
console.log('LUSH_SSH_HOST ' + JSON.stringify({port:report.port, pid:report.pid}));
`;

export function hostScript(payload, profile, probe) {
  const name = `${payload.fingerprint}-${payload.target}`;
  const compatible = probe.bun_path && /^1\.(?:[2-9]|\d{2,})\./.test(probe.bun_version);
  return `# lush-ssh:host
${COMMON}
prepare_base
root="$base/versions/"${shellQuote(name)}
[ -d "$root" ] && [ ! -L "$root" ] || die UNSAFE_DIRECTORY
bun="$root/bun"
[ -f "$bun" ] && [ ! -L "$bun" ] || die PRIVATE_BUN
sum=$(sha256sum "$bun"); sum=\${sum%% *}
[ "$sum" = ${shellQuote(payload.bunSha256)} ] || die BUN_HASH
${compatible ? `bun=${shellQuote(probe.bun_path)}` : ''}
profile="$base/profiles/"${shellQuote(profile.id)}
safe_dir "$profile"
"$bun" -e ${shellQuote(HOST)} "$root" "$profile" ${shellQuote(`http://127.0.0.1:${profile.port}`)} ${shellQuote(payload.fingerprint)} || die HOST_START
`;
}
