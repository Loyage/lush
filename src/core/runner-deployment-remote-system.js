import { createHash } from 'node:crypto';
import { deploymentAptScript } from './runner-deployment-remote-apt.js';

// Pure, self-contained and serialized alongside remoteRuntime. Never execute a
// script supplied in a plan. The remote recomputes this spec and compares it.
export function deploymentSystemSpecification({ id, uid, sleep_path, git_candidate = null, git_transaction = null }, apt_script = deploymentAptScript, hash = null) {
  const assert = condition => { if (!condition) throw new Error('Invalid deployment system specification'); };
  assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) && Number.isSafeInteger(uid) && uid > 0 && uid <= 4294967294);
  assert(['/usr/bin/sleep', '/bin/sleep'].includes(sleep_path));
  assert(git_candidate === null || typeof git_candidate === 'string' && /^[A-Za-z0-9][A-Za-z0-9.+:~_-]{0,159}$/.test(git_candidate));
  const name = `lush-runner-delegate-${uid}-${id}.service`, path = '/etc/systemd/system/' + name;
  const cgroup_installer = `lush-runner-cgroup-install-${uid}-${id}.service`, git_installer = `lush-runner-git-install-${uid}-${id}.service`;
  const unit_text = `[Unit]\nDescription=Lush Runner dedicated delegation ${id}\n\n[Service]\nType=exec\nUser=${uid}\nExecStart=${sleep_path} infinity\nDelegate=yes\nDelegateSubgroup=supervisor\nKillMode=control-group\nRestart=no\nNoNewPrivileges=yes\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n`;
  const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
  // Only root-owned system executables and root-owned configuration directories.
  // No runtime/source/private home script is ever executed as root.
  const header = `set -eu\nPATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH\nLC_ALL=C; export LC_ALL\numask 077\n[ "$(id -u)" = 0 ]\n`;
  const cgroup_script = header + `
[ "$(readlink -f /etc/systemd/system)" = /etc/systemd/system ]
[ "$(stat -c '%u:%a' /etc/systemd/system)" = 0:755 ]
[ "$(/usr/bin/systemctl show --property=LoadState --value ${quote(name)})" = not-found ]
for file in ${quote(path)} ${quote('/etc/systemd/system/multi-user.target.wants/' + name)} ${quote('/run/systemd/system/' + name)} ${quote('/usr/lib/systemd/system/' + name)} ${quote('/lib/systemd/system/' + name)}; do [ ! -e "$file" ] && [ ! -L "$file" ]; done
# Exclusive hard-link publication cannot overwrite a concurrent/unknown unit.
tmp=${quote('/etc/systemd/system/.lush-runner-' + id + '.unit')}
[ ! -e "$tmp" ] && [ ! -L "$tmp" ]
(set -C; printf '%s' ${quote(unit_text)} > "$tmp")
chmod 644 "$tmp"
sync -d "$tmp"
ln -- "$tmp" ${quote(path)}
rm -- "$tmp"
sync -d /etc/systemd/system
/usr/bin/systemctl daemon-reload
[ -z "$(/usr/bin/systemctl show --property=DropInPaths --value ${quote(name)})" ]
[ "$(/usr/bin/systemctl show --property=FragmentPath --value ${quote(name)})" = ${quote(path)} ]
/usr/bin/systemctl enable -- ${quote(name)}
/usr/bin/systemctl start -- ${quote(name)}
`;
  let git_script = null, git_unit_text = null, git_install = null;
  if (git_transaction?.supported === true) {
    const tx = git_transaction, hex = /^[a-f0-9]{64}$/;
    assert(tx.reason === null && tx.configuration_policy === 'stock-debconf-isolation-v1' && tx.candidate === git_candidate && ['amd64', 'arm64'].includes(tx.architecture) && tx.packages_truncated === false && ['repositories_sha256', 'installed_sha256', 'installed_versions_sha256', 'solution_sha256'].every(k => hex.test(tx[k])));
    assert(Array.isArray(tx.packages) && tx.packages.length > 0 && tx.packages.length <= 128 && tx.packages.every((p, i) => /^[a-z0-9][a-z0-9+.-]{0,127}$/.test(p.name) && /^[A-Za-z0-9][A-Za-z0-9.+:~_-]{0,159}$/.test(p.version) && p.previous_version === null && p.operation === 'install' && (!i || tx.packages[i - 1].name < p.name)) && tx.packages.some(p => p.name === 'git' && p.version === git_candidate));
    const observed = `apt_supported=1\napt_reason=none\napt_configuration_policy=stock-debconf-isolation-v1\napt_candidate=${tx.candidate}\napt_architecture=${tx.architecture}\napt_repositories_sha256=${tx.repositories_sha256}\napt_installed_sha256=${tx.installed_sha256}\napt_installed_versions_sha256=${tx.installed_versions_sha256}\napt_solution_sha256=${tx.solution_sha256}\n` + tx.packages.map(p => `apt_package=${p.name}\t${p.version}\n`).join('');
    const observation_path = '/etc/systemd/system/.lush-runner-git-' + id + '.stopped', invocation_path = '/etc/systemd/system/.lush-runner-git-' + id + '.invocation';
    const recheck = `observed=$(/usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C LANG=C /bin/sh -c ${quote(apt_script())})\n[ "$observed" = ${quote(observed.trimEnd())} ]\n`;
    const hook = `set -eu\n${recheck}
files=$(head -c 1048577); [ "\${#files}" -le 1048576 ]
rows=$(while IFS= read -r file; do
 case "$file" in /var/cache/apt/archives/*.deb) ;; *) exit 41;; esac
 [ ! -L "$file" ] && [ -f "$file" ] && [ "$(stat -c '%u:%h' "$file")" = 0:1 ]
 case "$(stat -c '%a' "$file")" in [4567][0145][0145]) ;; *) exit 41;; esac
 /usr/bin/dpkg-deb --show '--showformat=\${Package}\\t\${Version}\\t\${Architecture}\\n' "$file"
done <<LCM_DEBS
$files
LCM_DEBS
)
normalized=$(printf '%s\\n' "$rows" | awk -F '\\t' -v a=${quote(tx.architecture)} 'NF!=3 || ($3!=a && $3!="all") || seen[$1]++ {bad=1} {out=out $1 "\\t" $2 "\\n"} END {if(bad) exit 41; printf "%s",out}')
[ "$(printf '%s\\n' "$normalized" | sort -S 16M | sha256sum | cut -d ' ' -f 1)" = ${quote(tx.solution_sha256)} ]
`;
    const hookCommand = '/bin/sh -c ' + quote(hook);
    const assignments = tx.packages.map(p => quote(p.name + '=' + p.version)).join(' ');
    const git_exec = header + `
case "$LUSH_INSTALLER_INVOCATION" in ''|*[!a-f0-9]*) exit 41;; esac
[ "\${#LUSH_INSTALLER_INVOCATION}" = 32 ]
[ ! -e ${quote(invocation_path)} ] && [ ! -L ${quote(invocation_path)} ]
(set -C; printf '%s\\n' "$LUSH_INSTALLER_INVOCATION" > ${quote(invocation_path)})
chmod 644 ${quote(invocation_path)}; sync -d ${quote(invocation_path)}; sync -d /etc/systemd/system
[ ! -x /usr/bin/git ] && [ ! -x /bin/git ]
distro=$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"' | head -n 1)
case "$distro" in debian|ubuntu) ;; *) exit 41;; esac
${recheck}
exec 8<<LCM_APT_LOCAL_POLICY
#clear DPkg::Pre-Install-Pkgs;
LCM_APT_LOCAL_POLICY
/usr/bin/apt-get -c /proc/self/fd/8 -y --no-install-recommends --no-install-suggests --no-remove --no-upgrade -o Acquire::Retries=0 -o Dpkg::Use-Pty=0 -o DPkg::Lock::Timeout=0 -o APT::Solver=internal -o APT::Planner=internal -o ${quote('DPkg::Pre-Install-Pkgs::=' + hookCommand)} -o DPkg::Tools::Options::/bin/sh::Version=1 -o DPkg::Tools::Options::/bin/sh::InfoFD=0 install ${assignments}
# Postcondition compares every preexisting package/version/status, not just git.
query=$( (/usr/bin/dpkg-query -W '-f=\${Package}\\t\${Version}\\t\${Architecture}\\t\${db:Status-Status}\\n' && printf 'LCM_QUERY_OK\\n') | head -c 4194305)
[ "\${#query}" -le 4194304 ] && [ "$(printf '%s\\n' "$query" | tail -n 1)" = LCM_QUERY_OK ]
query=$(printf '%s\\n' "$query" | sed '$d' | sort -S 16M)
base=$(printf '%s\\n' "$query" | awk -F '\\t' -v pins=${quote(tx.packages.map(p => p.name + '=' + p.version).join(' '))} -v arch=${quote(tx.architecture)} '
 BEGIN {n=split(pins,x," "); for(i=1;i<=n;i++){split(x[i],p,"="); want[p[1]]=p[2]}}
 $1 in want {if(NF!=4 || $2!=want[$1] || ($3!=arch && $3!="all") || $4!="installed" || seen[$1]++) bad=1; count++; next}
 {print}
 END {if(bad || count!=n) exit 41}')
[ "$(printf '%s\\n' "$base" | sha256sum | cut -d ' ' -f 1)" = ${quote(tx.installed_versions_sha256)} ]
[ -z "$(/usr/bin/dpkg --audit)" ]
`;
    const arg = value => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\$/g, '$$$$').replace(/%/g, '%%') + '"';
    git_unit_text = `[Unit]\nDescription=Lush Runner approved Git transaction ${id}\n\n[Service]\nType=exec\nUser=0\nExitType=cgroup\nExecStart=/usr/bin/env -i LUSH_INSTALLER_INVOCATION=\${INVOCATION_ID} PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C LANG=C DEBIAN_FRONTEND=noninteractive TMPDIR=/tmp /bin/sh -c ${arg(git_exec)}\nRuntimeMaxSec=90s\nTimeoutStopSec=5s\nKillMode=control-group\nRestart=no\nUMask=0077\n`;
    const git_path = '/etc/systemd/system/' + git_installer;
    git_script = header + `
[ "$(readlink -f /etc/systemd/system)" = /etc/systemd/system ] && [ "$(stat -c '%u:%a' /etc/systemd/system)" = 0:755 ]
[ "$(/usr/bin/systemctl show --property=LoadState --value ${quote(git_installer)})" = not-found ]
for file in ${quote(git_path)} ${quote(observation_path)} ${quote(invocation_path)} ${quote('/run/systemd/system/' + git_installer)} ${quote('/usr/lib/systemd/system/' + git_installer)} ${quote('/lib/systemd/system/' + git_installer)}; do [ ! -e "$file" ] && [ ! -L "$file" ]; done
tmp=${quote('/etc/systemd/system/.lush-runner-git-' + id + '.unit')}
[ ! -e "$tmp" ] && [ ! -L "$tmp" ]
(set -C; printf '%s' ${quote(git_unit_text)} > "$tmp")
chmod 644 "$tmp"; sync -d "$tmp"; ln -- "$tmp" ${quote(git_path)}; rm -- "$tmp"; sync -d /etc/systemd/system
/usr/bin/systemctl daemon-reload
[ -z "$(/usr/bin/systemctl show --property=DropInPaths --value ${quote(git_installer)})" ]
[ "$(/usr/bin/systemctl show --property=FragmentPath --value ${quote(git_installer)})" = ${quote(git_path)} ]
/usr/bin/systemctl --wait start -- ${quote(git_installer)}
# This is a manager ExitType=cgroup barrier, NOT SSH or MainPID exit.
[ ! -L ${quote(invocation_path)} ] && [ "$(stat -c '%u:%a:%h' ${quote(invocation_path)})" = 0:644:1 ]
invocation=$(cat ${quote(invocation_path)})
case "$invocation" in ''|*[!a-f0-9]*) exit 41;; esac
[ "\${#invocation}" = 32 ]
(set -C; printf '%s\\n' ${quote(id)} ${quote(git_installer)} "$invocation" ${quote(tx.solution_sha256)} systemctl-wait-exit-type-cgroup > ${quote(observation_path)})
chmod 644 ${quote(observation_path)}; sync -d ${quote(observation_path)}; sync -d /etc/systemd/system
`;
    assert(git_unit_text.length <= 65536 && git_script.length <= 100000);
    git_install = { unit_name: git_installer, unit_path: git_path, observation_path, invocation_path, unit_summary: 'Root-owned one-shot Git installer; ExitType=cgroup, 90s runtime, 5s stop timeout, KillMode=control-group; never enabled or retried', effect: 'Create this new unit and start once; install only the complete pinned new-package set, no upgrades/removals; retain unit, two fixed root-owned observation files and partial state; isolate only the exact stock debconf preconfiguration hook in process-local APT config, never edit OS configuration', transaction: tx, packages: tx.packages, packages_truncated: false };
  }
  const plan = { version: 1, unit: { name, path, uid, sleep_path, supervisor: 'supervisor', runner: 'runner', bind_control_group_after_start: true, enable: true, start: true },
    installer: { cgroup: cgroup_installer, git: git_installer, runtime_max_sec: 90, timeout_stop_sec: 5, kill_mode: 'control-group' }, git: git_candidate ? { package: 'git', candidate: git_candidate, supported: !!git_install } : null, git_install };
  if (hash) {
    plan.unit.sha256 = hash(unit_text);
    plan.cgroup_setup = { unit_path: path, unit_sha256: plan.unit.sha256, unit_summary: 'Non-root dedicated systemd delegation; Delegate=yes, DelegateSubgroup=supervisor, fixed sleep', effect: 'Create only this new unit, enable/start it, query actual ControlGroup and create its empty dedicated Runner child' };
    if (plan.git_install) plan.git_install = { ...plan.git_install, unit_sha256: hash(git_unit_text) };
    plan.scripts = { cgroup_sha256: hash(cgroup_script), git_sha256: git_script ? hash(git_script) : null };
  }
  return { plan, unit_text, cgroup_script, git_script, git_unit_text, git_observation: git_install ? `apt_supported=1\napt_reason=none\napt_configuration_policy=stock-debconf-isolation-v1\napt_candidate=${git_transaction.candidate}\napt_architecture=${git_transaction.architecture}\napt_repositories_sha256=${git_transaction.repositories_sha256}\napt_installed_sha256=${git_transaction.installed_sha256}\napt_installed_versions_sha256=${git_transaction.installed_versions_sha256}\napt_solution_sha256=${git_transaction.solution_sha256}\n` + git_transaction.packages.map(p => `apt_package=${p.name}\t${p.version}`).join('\n') : null };
}

/** Public-plan-safe metadata; never contains inline scripts or credential hashes. */
export function buildDeploymentSystemPlan({ id, target, system }) {
  if (!system || system.systemd < 250 || system.systemd < 254 && !system.git_transaction?.supported || !system.system_tools || !system.sleep_path) return null;
  return deploymentSystemSpecification({ id, uid: target.uid, sleep_path: system.sleep_path, git_candidate: system.git_candidate || null, git_transaction: system.git_transaction }, deploymentAptScript, bytes => createHash('sha256').update(bytes).digest('hex')).plan;
}
