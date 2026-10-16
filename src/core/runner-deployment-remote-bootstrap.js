import { deploymentAbiScript } from './runner-deployment-remote-abi.js';

// Fixed POSIX bootstrap before a verified Bun exists. All substitutions are validated
// internal metadata; node configuration/credentials are NEVER placed in a command.
const q = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
const PATH = '/usr/sbin:/usr/bin:/sbin:/bin:/run/current-system/sw/bin';
const text = value => JSON.stringify(value);
export function bootstrapScript({ id, plan, plan_sha256, operation, artifact, runtime_script }) {
  const { target: t, remote: r } = plan;
  const prefix = [id, plan_sha256, r.machine_id, r.boot_id, t.uid, r.home_dev, r.home_ino].join(':');
  const abi = deploymentAbiScript(plan.abi);
  const common = `set -eu
PATH=${q(PATH)}; export PATH
LC_ALL=C; export LC_ALL
umask 077
no() { printf '{"ok":false,"code":"%s"}\\n' "$1"; exit 0; }
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = ${q(t.arch === 'x64' ? 'x86_64' : 'aarch64')} ] || no identity_changed
[ "$(id -u)" = ${q(t.uid)} ] && [ "$(id -un)" = ${q(t.user)} ] || no identity_changed
home=$(getent passwd ${q(t.uid)} | cut -d : -f 6)
[ "$home" = ${q(t.home)} ] && [ "$(readlink -f -- "$home")" = "$home" ] || no identity_changed
[ "$(sha256sum /etc/machine-id | cut -d ' ' -f 1)" = ${q(r.machine_id)} ] && [ "$(sha256sum /proc/sys/kernel/random/boot_id | cut -d ' ' -f 1)" = ${q(r.boot_id)} ] || no identity_changed
cd -P -- "$home"
[ "$(stat -Lc '%u:%d:%i' .)" = ${q(`${t.uid}:${r.home_dev}:${r.home_ino}`)} ] || no identity_changed
${abi}
[ "$abi_ready" = 1 ] || no identity_changed
${plan.abi.profile ? `[ "$abi_observed_sha256" = ${q(r.abi_observed_sha256)} ] || no identity_changed` : ''}
prefix=${q(prefix)}
lock=.lush-runner-deployment.lock
private_file() {
  [ ! -L "$1" ] && [ -f "$1" ] && [ "$(stat -c '%u:%a:%h' -- "$1")" = "${t.uid}:\${2:-600}:1" ] || no identity_changed
}
enter() {
  [ ! -L "$1" ] && [ -d "$1" ] && [ "$(stat -c '%u' -- "$1")" = ${q(t.uid)} ] || no identity_changed
  mode=$(stat -c '%a' -- "$1")
  case "$mode" in [57][0145][0145]) ;; *) no identity_changed;; esac
  cd -P -- "$1"
  [ "$(pwd -P)" = "$2" ] || no identity_changed
}
`;
  const hierarchy = ['.local', 'share', 'lush-runner', 'managed'];
  let absolute = t.home;
  let enter = '';
  for (const name of hierarchy) {
    absolute += '/' + name;
    enter += `${operation === 'prepare' ? `[ -e ${q(name)} ] || [ -L ${q(name)} ] || mkdir -m 700 -- ${q(name)}\nsync -d .\n` : ''}enter ${q(name)} ${q(absolute)}\n`;
  }
  if (operation === 'prepare') return common + `
# mkdir is the exclusive first effect. A crash before owner publication leaves an
# unowned lock, which every future operation refuses, rather than guessing stale.
[ ! -e "$home/.config/lush-runner/config.json" ] && [ ! -L "$home/.config/lush-runner/config.json" ] || no already_exists
mkdir -m 700 -- "$lock" 2>/dev/null || no busy
(set -C; printf '%s\\n' "$prefix" > "$lock/owner")
sync -d "$lock/owner"
sync -d "$lock"
sync -d .
${enter}
# Unknown or unfinished managed directories must not be bypassed with a new UUID.
for prior in .* *; do
  case "$prior" in .|..|'.*'|'*') continue;; esac
  no already_exists
done
mkdir -m 700 -- ${q(id)} 2>/dev/null || no already_exists
sync -d .
enter ${q(id)} ${q(plan.install_root)}
root_identity=$(stat -c '%d:%i' .)
mkdir -m 700 -- stages
(set -C; : > execution-lock)
(set -C; printf '%s:%s:%s:%s\\n' "$prefix" "$root_identity" "$(stat -c '%d:%i' stages)" "$(stat -c '%d:%i' execution-lock)" > receipt)
(set -C; printf '%s\\n' "$prefix" > stages/prepare.done)
sync -d receipt execution-lock stages/prepare.done stages .
printf '{"ok":true,"stage":"prepare","root_identity":"%s"}\\n' "$root_identity"
`;
  const existing = common + `
[ ! -L "$lock" ] && [ -d "$lock" ] || no identity_changed
private_file "$lock/owner"
[ "$(head -c 2049 "$lock/owner")" = "$prefix" ] || no identity_changed
${enter}
enter ${q(id)} ${q(plan.install_root)}
private_file receipt
[ "$(head -c 2049 receipt)" = "$prefix:$(stat -c '%d:%i' .):$(stat -c '%d:%i' stages):$(stat -c '%d:%i' execution-lock)" ] || no identity_changed
private_file execution-lock
[ ! -L stages ] && [ -d stages ] && [ "$(stat -c '%u:%a' stages)" = ${q(`${t.uid}:700`)} ] || no identity_changed
`;
  if (operation === 'runtime') return existing + `
[ ! -e stages/runtime.started ] && [ ! -L stages/runtime.started ] || no stage_already_started
[ ! -e bun ] && [ ! -L bun ] && [ ! -e runtime.upload ] && [ ! -L runtime.upload ] || no already_exists
(set -C; printf '%s\\n' "$prefix" > stages/runtime.started)
sync -d stages/runtime.started stages .
(set -C; head -c ${artifact.size + 1} > runtime.upload)
if [ "$(stat -c '%s' runtime.upload)" != ${q(artifact.size)} ] || [ "$(sha256sum runtime.upload | cut -d ' ' -f 1)" != ${q(artifact.sha256)} ]; then
  (set -C; printf '%s\\n' "$prefix" > stages/runtime.failed)
  sync -d stages/runtime.failed stages
  no artifact_changed
fi
chmod 700 runtime.upload
ln -- runtime.upload bun
rm -- runtime.upload
sync -d bun .
(set -C; printf '%s\\n' "$prefix" > stages/runtime.done)
sync -d stages/runtime.done stages
printf '%s\\n' ${q(text({ ok: true, stage: 'runtime', sha256: artifact.sha256, size: artifact.size }))}
`;
  if (operation === 'inspect-bootstrap') return existing + `
runtime=missing
if [ -f bun ] && [ ! -L bun ]; then
  if [ "$(stat -c '%u:%a:%h:%s' bun)" = ${q(`${t.uid}:700:1:${plan.runtime.size}`)} ] && [ "$(sha256sum bun | cut -d ' ' -f 1)" = ${q(plan.runtime.sha256)} ]; then runtime=verified; else runtime=changed; fi
fi
started=0; done=0; failed=0; prepare=unknown
for marker in prepare.done runtime.started runtime.done runtime.failed; do
  if [ -e "stages/$marker" ] || [ -L "stages/$marker" ]; then
    private_file "stages/$marker"
    [ "$(head -c 2049 "stages/$marker")" = "$prefix" ] || no identity_changed
    case "$marker" in prepare.done) prepare=done;; runtime.started) started=1;; runtime.done) done=1;; runtime.failed) failed=1;; esac
  fi
done
printf '{"ok":true,"stage":"inspect-bootstrap","runtime":"%s","prepare":"%s","started":%s,"done":%s,"failed":%s}\\n' "$runtime" "$prepare" "$started" "$done" "$failed"
`;
  // Hash and execute the same open inode, not a pathname checked before an exec.
  return existing + `
private_file bun 700
exec 9< ./bun
[ "$(stat -Lc '%u:%a:%h:%s' /proc/self/fd/9)" = ${q(`${t.uid}:700:1:${plan.runtime.size}`)} ] && [ "$(sha256sum /proc/self/fd/9 | cut -d ' ' -f 1)" = ${q(plan.runtime.sha256)} ] || no artifact_changed
[ "$(stat -c '%d:%i' bun)" = "$(stat -Lc '%d:%i' /proc/self/fd/9)" ] && [ ! -L bun ] || no identity_changed
exec /usr/bin/env -i PATH=${q(PATH)} HOME=${q(plan.install_root)} USER=${q(t.user)} LOGNAME=${q(t.user)} LANG=C LC_ALL=C BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 /proc/self/fd/9 --no-install --no-env-file --config=/dev/null -e ${q(runtime_script)}
`;
}
