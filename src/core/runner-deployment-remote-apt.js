import { createHash } from 'node:crypto';

// Read-only, bounded, deliberately conservative Debian/Ubuntu APT subset. No
// temporary files, downloads, updates, sudo or auto-repair. Serialized verbatim.
export function deploymentAptScript() {
  return `set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH
LC_ALL=C; LANG=C; TMPDIR=/dev/null; export LC_ALL LANG TMPDIR
apt_no() { printf 'apt_supported=0\\napt_reason=%s\\n' "$1"; exit 0; }
apt_sha() { sha256sum | cut -d ' ' -f 1; }
apt_capture() {
  apt_output=$( (set +e; "$@" 2>/dev/null; printf '\\nLUSH_APT_RC=%s\\n' "$?") | head -c 4194305)
  [ "\${#apt_output}" -le 4194304 ] && [ "$(printf '%s\\n' "$apt_output" | tail -n 1)" = LUSH_APT_RC=0 ] || apt_no command_unavailable
  apt_output=$(printf '%s\\n' "$apt_output" | sed '$d')
}
apt_root() {
  [ ! -L "$1" ] && [ "$(stat -c '%u' -- "$1")" = 0 ] || return 1
  case "$(stat -c '%a' -- "$1")" in [0145][0145][0145]|[4567][0145][0145]) ;; *) return 1;; esac
}
for apt_dir in /etc /var /var/lib /var/lib/dpkg /var/lib/dpkg/info /var/lib/dpkg/updates /var/lib/apt /var/lib/apt/lists /usr /usr/bin /usr/share /usr/share/keyrings /usr/lib /usr/lib/apt /usr/lib/apt/methods; do
  [ -d "$apt_dir" ] && apt_root "$apt_dir" && [ "$(readlink -f "$apt_dir")" = "$apt_dir" ] || apt_no repository_unverifiable
done
apt_tools=''
for tool in /usr/bin/apt-get /usr/bin/apt-cache /usr/bin/apt-config /usr/bin/dpkg /usr/bin/dpkg-query /usr/bin/dpkg-deb /usr/bin/timeout; do
  [ -x "$tool" ] && [ "$(stat -Lc '%u' "$tool")" = 0 ] || apt_no command_unavailable
  case "$(stat -Lc '%a' "$tool")" in [4567][0145][0145]) ;; *) apt_no command_unavailable;; esac
  case "$(readlink -f "$tool")" in /usr/bin/*|/usr/sbin/*) ;; *) apt_no command_unavailable;; esac
  apt_tools="$apt_tools$tool:$(sha256sum "$tool" | cut -d ' ' -f 1)\\n"
done
for tool in /usr/lib/apt/methods/http /usr/lib/apt/methods/https /usr/lib/apt/methods/gpgv /usr/lib/apt/methods/store; do
  [ -f "$tool" ] && [ "$(stat -Lc '%u' "$tool")" = 0 ] || apt_no command_unavailable
  case "$(stat -Lc '%a' "$tool")" in [4567][0145][0145]) ;; *) apt_no command_unavailable;; esac
  case "$(readlink -f "$tool")" in /usr/lib/apt/methods/*) ;; *) apt_no command_unavailable;; esac
  apt_tools="$apt_tools$tool:$(sha256sum "$tool" | cut -d ' ' -f 1)\\n"
done
apt_capture /usr/bin/timeout -k 2 10 /usr/bin/dpkg-query -W '-f=\${Package}\\t\${Version}\\t\${Architecture}\\t\${db:Status-Status}\\n'
apt_query=$(printf '%s\\n' "$apt_output" | sort -S 16M)
printf '%s\\n' "$apt_query" | awk -F '\\t' 'NF!=4 || $1 !~ /^[a-z0-9][a-z0-9+.-]*$/ || $2 !~ /^[A-Za-z0-9][A-Za-z0-9.+:~_-]*$/ || $3 !~ /^[a-z0-9][a-z0-9-]*$/ || ($4!="installed" && $4!="config-files") {bad=1} END {exit bad}' || apt_no dpkg_unready
if printf '%s\\n' "$apt_query" | awk -F '\\t' '$1=="git" {found=1} END {exit !found}'; then apt_no already_installed; fi
apt_arch=$(/usr/bin/dpkg --print-architecture 2>/dev/null) || apt_no command_unavailable
case "$apt_arch" in amd64|arm64) ;; *) apt_no architecture_unsupported;; esac
apt_capture /usr/bin/timeout -k 2 10 /usr/bin/dpkg --audit
[ -z "$apt_output" ] || apt_no dpkg_unready
[ -d /var/lib/dpkg/updates ] && [ -z "$(find /var/lib/dpkg/updates -mindepth 1 -maxdepth 1 -print -quit)" ] || apt_no dpkg_unready
apt_dpkg_config=$( (if [ -f /etc/dpkg/dpkg.cfg ]; then cat /etc/dpkg/dpkg.cfg; fi; if [ -d /etc/dpkg/dpkg.cfg.d ]; then find /etc/dpkg/dpkg.cfg.d -type f -exec cat {} +; fi) | head -c 1048577)
[ "\${#apt_dpkg_config}" -le 1048576 ] || apt_no configuration_unsupported
printf '%s\\n' "$apt_dpkg_config" | awk '/^[[:space:]]*(#|$)/ {next} $0=="no-debsig" || $0=="log /var/log/dpkg.log" {next} {bad=1} END {exit bad}' || apt_no configuration_unsupported
apt_capture /usr/bin/timeout -k 2 10 /usr/bin/apt-config dump
apt_config=$apt_output
# Configuration that redirects package management, trust, executables, or install
# hooks is NOT adopted. Only the exact stock debconf preconfiguration helper
# is recognized; a late process-local config clears it before the archive gate.
# No system configuration is edited and no preconfiguration script is executed.
printf '%s\\n' "$apt_config" | awk '
BEGIN {
a["Dir"]= "\\\"/\\\";"; a["Dir::State"]="\\\"var/lib/apt\\\";"; a["Dir::State::lists"]="\\\"lists/\\\";"; a["Dir::State::cdroms"]="\\\"cdroms.list\\\";"; a["Dir::State::status"]="\\\"/var/lib/dpkg/status\\\";"; a["Dir::State::extended_states"]="\\\"extended_states\\\";";
a["Dir::Cache"]="\\\"var/cache/apt\\\";"; a["Dir::Cache::archives"]="\\\"archives/\\\";"; a["Dir::Cache::srcpkgcache"]="\\\"srcpkgcache.bin\\\";"; a["Dir::Cache::pkgcache"]="\\\"pkgcache.bin\\\";";
a["Dir::Etc"]="\\\"etc/apt\\\";"; a["Dir::Etc::sourcelist"]="\\\"sources.list\\\";"; a["Dir::Etc::sourceparts"]="\\\"sources.list.d\\\";"; a["Dir::Etc::main"]="\\\"apt.conf\\\";"; a["Dir::Etc::netrc"]="\\\"auth.conf\\\";"; a["Dir::Etc::netrcparts"]="\\\"auth.conf.d\\\";"; a["Dir::Etc::parts"]="\\\"apt.conf.d\\\";"; a["Dir::Etc::preferences"]="\\\"preferences\\\";"; a["Dir::Etc::preferencesparts"]="\\\"preferences.d\\\";"; a["Dir::Etc::trusted"]="\\\"trusted.gpg\\\";"; a["Dir::Etc::trustedparts"]="\\\"trusted.gpg.d\\\";";
a["Dir::Bin::methods"]="\\\"/usr/lib/apt/methods\\\";"; a["Dir::Bin::dpkg"]="\\\"/usr/bin/dpkg\\\";"; a["Dir::Bin::solvers"]="\\\"\\\";"; a["Dir::Bin::solvers::"]="\\\"/usr/lib/apt/solvers\\\";"; a["Dir::Bin::planners"]="\\\"\\\";"; a["Dir::Bin::planners::"]="\\\"/usr/lib/apt/planners\\\";"; a["Dir::Bin::gzip"]="\\\"/bin/gzip\\\";"; a["Dir::Bin::bzip2"]="\\\"/bin/bzip2\\\";"; a["Dir::Bin::xz"]="\\\"/usr/bin/xz\\\";"; a["Dir::Bin::lz4"]="\\\"/usr/bin/lz4\\\";"; a["Dir::Bin::zstd"]="\\\"/usr/bin/zstd\\\";"; a["Dir::Bin::lzma"]="\\\"/usr/bin/xz\\\";"; a["Dir::Media::MountPath"]="\\\"/media/apt\\\";"; a["Dir::Log"]="\\\"var/log/apt\\\";"; a["Dir::Log::Terminal"]="\\\"term.log\\\";"; a["Dir::Log::History"]="\\\"history.log\\\";"; a["Dir::Log::Planner"]="\\\"eipp.log.xz\\\";";
for(key in a) b[tolower(key)]=a[key];
}
{ k=tolower($1); v=$0; sub(/^[^ ]+ +/,"",v);
 if(k ~ /^dir/ && !(k in b) && k!="dir::ignore-files-silently::" && v!="\\\"\\\";") bad=1;
 if(k in b && v!=b[k]) bad=1;
 if(k ~ /^binary::/ || (k ~ /^apt::(solver|planner)$/ && v!="\\\"internal\\\";") || k ~ /^dpkg::options/ || k ~ /^dpkg::(pre|post)-invoke/ || k ~ /^apt::install::(pre|post)/ || k=="rootdir") bad=1;
 if(k ~ /^dpkg::pre-install-pkgs/ && v!="\\\"\\\";" && !(k=="dpkg::pre-install-pkgs::" && v=="\\\"/usr/sbin/dpkg-preconfigure --apt || true\\\";")) bad=1;
 if(k ~ /allowunauthenticated|allowinsecure|allowweak|allowdowngradetoinsecure|force-yes/ && v!="\\\"false\\\";" && v!="\\\"0\\\";") bad=1;
 if(k ~ /check-valid-until|check-date/ && v!="\\\"true\\\";" && v!="\\\"1\\\";") bad=1;
} END {exit bad}' || apt_no configuration_unsupported
# Bind source/config/key/index bytes, canonical identity and executable policy.
apt_repo_data=$(for apt_base in /etc/apt /etc/dpkg /usr/share/keyrings /var/lib/apt/lists; do
  [ -d "$apt_base" ] || exit 41
  apt_root "$apt_base" || exit 41
  [ "$(readlink -f "$apt_base")" = "$apt_base" ] || exit 41
  apt_paths=$(find "$apt_base" -xdev \\( -path /var/lib/apt/lists/partial -o -path /var/lib/apt/lists/auxfiles -o -path /var/lib/apt/lists/lock \\) -prune -o -print | head -c 65537)
  [ "\${#apt_paths}" -le 65536 ] || exit 41
  apt_count=0; apt_total=0
  while IFS= read -r apt_path; do
    case "$apt_path" in ''|*[!A-Za-z0-9_./:%+@=-]*) exit 41;; esac
    apt_count=$((apt_count+1)); [ "$apt_count" -le 512 ] || exit 41
    apt_root "$apt_path" || exit 41
    if [ -d "$apt_path" ]; then continue; fi
    [ -f "$apt_path" ] && [ -r "$apt_path" ] && [ "$(stat -c '%h' "$apt_path")" = 1 ] || exit 41
    apt_size=$(stat -c '%s' "$apt_path"); apt_total=$((apt_total+apt_size)); [ "$apt_size" -le 536870912 ] && [ "$apt_total" -le 1073741824 ] || exit 41
    printf '%s:%s:%s\\n' "$apt_path" "$(stat -c '%u:%a:%s:%d:%i' "$apt_path")" "$(sha256sum "$apt_path" | cut -d ' ' -f 1)"
  done <<LCM_APT_PATHS
$apt_paths
LCM_APT_PATHS
done) || apt_no repository_unverifiable
# External signing keys/inline trust bypasses must not escape the fingerprint.
apt_sources=$(find /etc/apt -type f \\( -name '*.list' -o -name '*.sources' \\) -exec cat {} + | head -c 1048577)
[ "\${#apt_sources}" -le 1048576 ] || apt_no repository_unverifiable
if printf '%s\\n' "$apt_sources" | grep -Ei 'trusted[= :]+(yes|true|1)|allow-[a-z-]+[= :]+(yes|true|1)|check-(valid-until|date)[= :]+(no|false|0)|file:|cdrom:' >/dev/null; then apt_no repository_unverifiable; fi
if printf '%s\\n' "$apt_sources" | grep -E '^[[:space:]]+[^#[:space:]]' >/dev/null; then apt_no repository_unverifiable; fi
apt_keys=$(printf '%s\\n' "$apt_sources" | awk '{low=tolower($0); if(match(low,/signed-by=/)){v=substr($0,RSTART+10);split(v,key,"]");split(key[1],word," ");print word[1]} else if(low ~ /^signed-by:/){v=$0;sub(/^[^:]+:[ ]*/,"",v);if(v=="") exit 41; print v}}') || apt_no repository_unverifiable
for apt_key in $apt_keys; do case "$apt_key" in /etc/apt/*|/usr/share/keyrings/*) [ -r "$apt_key" ] && [ ! -L "$apt_key" ] && [ "$(readlink -f "$apt_key")" = "$apt_key" ] || apt_no repository_unverifiable;; *) apt_no repository_unverifiable;; esac; done
apt_capture /usr/bin/timeout -k 2 10 /usr/bin/apt-cache policy git
apt_policy=$apt_output
apt_candidate=$(printf '%s\\n' "$apt_policy" | awk '/^[ ]*Candidate: / {if(++n>1) exit 41; print $2} END {if(n!=1) exit 41}') || apt_no candidate_unavailable
case "$apt_candidate" in ''|*[!A-Za-z0-9.+:~_-]*|'(none)') apt_no candidate_unavailable;; esac
[ "\${#apt_candidate}" -le 160 ] || apt_no candidate_unavailable
# -c is read AFTER the default configuration. Clearing a list with -o would
# append rather than remove inherited hooks. The descriptor holds fixed bytes,
# never a user file; CLI installs the sole final archive gate after this clear.
exec 8<<LCM_APT_LOCAL_POLICY
#clear DPkg::Pre-Install-Pkgs;
LCM_APT_LOCAL_POLICY
apt_capture /usr/bin/timeout -k 2 10 /usr/bin/apt-get -c /proc/self/fd/8 --simulate --no-install-recommends --no-install-suggests --no-remove --no-upgrade -o Dir::Cache::pkgcache= -o Dir::Cache::srcpkgcache= -o APT::Solver=internal -o APT::Planner=internal install "git=$apt_candidate"
apt_sim=$apt_output
# Accept only the complete known C-locale simulation grammar; unknown output or
# ANY installed-version bracket/removal/configure-only action blocks approval.
apt_packages=$(printf '%s\\n' "$apt_sim" | awk -v arch="$apt_arch" '
/^Reading package lists\\.\\.\\./ || /^Building dependency tree\\.\\.\\./ || /^Reading state information\\.\\.\\./ || /^The following (additional|NEW) packages will be installed:$/ || /^(Suggested|Recommended) packages:$/ || /^[ ]+[a-z0-9]/ || /^$/ {next}
/^[0-9]+ upgraded, [0-9]+ newly installed, 0 to remove and [0-9]+ not upgraded\\.$/ {if($1!=0 || summaries++) bad=1; expected=$3; next}
/^Inst / { if($2 !~ /^[a-z0-9][a-z0-9+.-]*$/ || $3 !~ /^\\([A-Za-z0-9][A-Za-z0-9.+:~_-]*$/ || $NF !~ /^\\[[a-z0-9-]+\\]\\)$/ || seen[$2]++) {bad=1; next} v=$3; sub(/^\\(/,"",v); a=$NF; sub(/^\\[/,"",a); sub(/\\]\\)$/, "",a); if(a!=arch && a!="all") bad=1; versions[$2]=v; count++; next }
/^Conf / {v=$3; sub(/^\\(/,"",v); if(versions[$2]!=v || conf[$2]++) bad=1; configured++; next}
{bad=1}
END {if(!versions["git"] || bad || summaries!=1 || expected!=count || count==0 || count>128 || configured!=count) exit 41; for(p in versions) print p "\\t" versions[p]}' | sort -S 16M) || apt_no solution_unsupported
# Pipeline status cannot hide an awk failure: a required git row plus a complete
# independent Conf/Inst count and normalized output sentinel are checked below.
[ -n "$apt_packages" ] && [ "$(printf '%s\\n' "$apt_packages" | awk -F '\\t' '$1=="git" {print $2}')" = "$apt_candidate" ] || apt_no solution_unsupported
apt_n=$(printf '%s\\n' "$apt_packages" | wc -l)
[ "$(printf '%s\\n' "$apt_sim" | grep -c '^Inst ')" = "$apt_n" ] && [ "$(printf '%s\\n' "$apt_sim" | grep -c '^Conf ')" = "$apt_n" ] || apt_no solution_unsupported
if printf '%s\\n' "$apt_sim" | grep -E '^Remv |^Inst [^ ]+ \\[' >/dev/null; then apt_no solution_unsupported; fi
for apt_pkg in $(printf '%s\\n' "$apt_packages" | cut -f 1); do
  if printf '%s\\n' "$apt_query" | awk -F '\\t' -v p="$apt_pkg" '$1==p {found=1} END {exit !found}'; then apt_no solution_unsupported; fi
done
apt_state=$(for apt_file in /var/lib/dpkg/status /var/lib/dpkg/arch /var/lib/dpkg/diversions /var/lib/dpkg/statoverride /var/lib/apt/extended_states; do
 if [ -e "$apt_file" ] || [ -L "$apt_file" ]; then apt_root "$apt_file" && [ -f "$apt_file" ] && [ -r "$apt_file" ] || exit 41; printf '%s:%s\\n' "$apt_file" "$(sha256sum "$apt_file" | cut -d ' ' -f 1)"; else printf '%s:absent\\n' "$apt_file"; fi
done) || apt_no dpkg_unready
apt_repo_sha=$(printf '%s\\n%s\\n%s\\n%s\\n' "$apt_repo_data" "$apt_config" "$apt_policy" "$apt_tools" | apt_sha)
apt_installed_sha=$(printf '%s\\n%s\\n' "$apt_state" "$apt_query" | apt_sha)
apt_versions_sha=$(printf '%s\\n' "$apt_query" | apt_sha)
apt_solution_sha=$(printf '%s\\n' "$apt_packages" | apt_sha)
printf 'apt_supported=1\\napt_reason=none\\napt_configuration_policy=stock-debconf-isolation-v1\\napt_candidate=%s\\napt_architecture=%s\\napt_repositories_sha256=%s\\napt_installed_sha256=%s\\napt_installed_versions_sha256=%s\\napt_solution_sha256=%s\\n' "$apt_candidate" "$apt_arch" "$apt_repo_sha" "$apt_installed_sha" "$apt_versions_sha" "$apt_solution_sha"
while IFS= read -r apt_row; do printf 'apt_package=%s\\n' "$apt_row"; done <<LCM_APT_PACKAGES
$apt_packages
LCM_APT_PACKAGES
`;
}

export function parseDeploymentApt(source) {
  const unavailable = reason => ({ supported: false, reason, candidate: null, packages: [], packages_truncated: false });
  try {
    const values = {}, packages = [];
    for (const line of source.trim().split('\n').filter(line => line.startsWith('apt_'))) {
      const i = line.indexOf('='), key = line.slice(0, i), value = line.slice(i + 1);
      if (key === 'apt_package') { const [name, version, extra] = value.split('\t'); if (extra !== undefined || !/^[a-z0-9][a-z0-9+.-]{0,127}$/.test(name) || !/^[A-Za-z0-9][A-Za-z0-9.+:~_-]{0,159}$/.test(version)) return unavailable('observation_invalid'); packages.push({ name, version, previous_version: null, operation: 'install' }); }
      else { if (Object.hasOwn(values, key)) return unavailable('observation_invalid'); values[key] = value; }
    }
    if (values.apt_supported !== '1') return unavailable(['command_unavailable', 'already_installed', 'architecture_unsupported', 'dpkg_unready', 'configuration_unsupported', 'repository_unverifiable', 'candidate_unavailable', 'solution_unsupported'].includes(values.apt_reason) ? values.apt_reason : 'observation_invalid');
    if (Object.keys(values).sort().join() !== ['apt_supported', 'apt_reason', 'apt_configuration_policy', 'apt_candidate', 'apt_architecture', 'apt_repositories_sha256', 'apt_installed_sha256', 'apt_installed_versions_sha256', 'apt_solution_sha256'].sort().join() || values.apt_reason !== 'none' || values.apt_configuration_policy !== 'stock-debconf-isolation-v1' || !['amd64', 'arm64'].includes(values.apt_architecture) || !/^[A-Za-z0-9][A-Za-z0-9.+:~_-]{0,159}$/.test(values.apt_candidate)) return unavailable('observation_invalid');
    for (const key of ['repositories_sha256', 'installed_sha256', 'installed_versions_sha256', 'solution_sha256']) if (!/^[a-f0-9]{64}$/.test(values['apt_' + key])) return unavailable('observation_invalid');
    if (!packages.length || packages.length > 128 || new Set(packages.map(p => p.name)).size !== packages.length || !packages.some(p => p.name === 'git' && p.version === values.apt_candidate) || packages.some((p, i) => i && packages[i - 1].name >= p.name)) return unavailable('observation_invalid');
    if (createHash('sha256').update(packages.map(p => `${p.name}\t${p.version}\n`).join('')).digest('hex') !== values.apt_solution_sha256) return unavailable('observation_invalid');
    return { supported: true, reason: null, configuration_policy: 'stock-debconf-isolation-v1', candidate: values.apt_candidate, architecture: values.apt_architecture, packages, packages_truncated: false, repositories_sha256: values.apt_repositories_sha256, installed_sha256: values.apt_installed_sha256, installed_versions_sha256: values.apt_installed_versions_sha256, solution_sha256: values.apt_solution_sha256 };
  } catch { return unavailable('observation_invalid'); }
}
