import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deploymentAptScript, parseDeploymentApt } from '../src/core/runner-deployment-remote-apt.js';
import { deploymentSystemSpecification } from '../src/core/runner-deployment-remote-system.js';
const q = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
const sha = value => createHash('sha256').update(value).digest('hex');
export function aptFixture(f) {
  const root = path.join(f.root, 'apt'), state = path.join(root, 'state.json'); fs.mkdirSync(root);
  const dirs = ['/etc/apt', '/etc/dpkg', '/usr/share/keyrings', '/usr/lib/apt/methods', '/var/lib/apt/lists', '/var/lib/dpkg/info', '/var/lib/dpkg/updates', '/var/cache/apt/archives', '/usr/bin', '/bin', '/etc/systemd/system', '/run/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system'];
  for (const dir of dirs) fs.mkdirSync(root + dir, { recursive: true, mode: 0o755 });
  fs.chmodSync(root + '/etc/systemd/system', 0o755);
  fs.writeFileSync(root + '/etc/os-release', 'ID=debian\n');
  fs.writeFileSync(root + '/bin/sh', '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o755 });
  fs.writeFileSync(root + '/var/lib/dpkg/status', 'baseline status\n'); fs.writeFileSync(root + '/etc/apt/sources.list', 'deb https://example.invalid/debian stable main\n'); fs.writeFileSync(root + '/var/lib/apt/lists/index', 'signed index fixture\n');
  const version = '1:2.39.5-1', packages = [{ name: 'git', version, arch: 'amd64' }, { name: 'git-man', version, arch: 'all' }];
  const sim = ['Reading package lists...', 'Building dependency tree...', 'Reading state information...', 'The following additional packages will be installed:', '  git-man', 'Suggested packages:', '  git-daemon-run', 'The following NEW packages will be installed:', '  git git-man', '0 upgraded, 2 newly installed, 0 to remove and 0 not upgraded.', ...packages.map(p => `Inst ${p.name} (${p.version} Debian:12/stable [${p.arch}])`), ...packages.map(p => `Conf ${p.name} (${p.version} Debian:12/stable [${p.arch}])`)].join('\n');
  fs.writeFileSync(state, JSON.stringify({ version, packages, sim, config: 'APT::Architecture "amd64";\n', query: 'basepkg\t1\tamd64\tinstalled\n', installed: false, install_calls: 0, unit_active: false, unit_started: false, extra: false, root_drift: false, after_main: false }));
  const rewrite = source => source.replaceAll('PATH=/usr/sbin:/usr/bin:/sbin:/bin', 'PATH=LCM_FIXTURE_PATH').replace(/(?<![A-Za-z0-9_])\/(?:etc|usr|var|run|lib|bin)\//g, match => root + match).replaceAll('PATH=LCM_FIXTURE_PATH', 'PATH=' + f.bin + ':/usr/sbin:/usr/bin:/sbin:/bin').replace('[ "$(id -u)" = 0 ]', '[ "$(id -u)" = ' + process.getuid() + ' ]');
  // Store the exact rewrite function for isolated child commands; never a public
  // adapter selector or production option. Every system path is redirected.
  const cli = path.join(root, 'cli.js');
  fs.writeFileSync(cli, `import fs from 'node:fs'; import cp from 'node:child_process';
const [tool,state,root,...a]=process.argv.slice(2), s=JSON.parse(fs.readFileSync(state));
if(tool==='apt-config') process.stdout.write(s.config.replace(/(?<![A-Za-z0-9_])\\/(?:etc|usr|var|run|lib|bin)\\//g,m=>root+m));
else if(tool==='apt-cache') console.log('git:\\n  Candidate: '+s.version);
else if(tool==='dpkg') {if(a[0]==='--print-architecture') console.log('amd64'); else if(a[0]==='--audit') {if(s.broken) console.log('pending');} else process.exitCode=1;}
else if(tool==='dpkg-query') {if(a.includes('git')) {if(s.installed) process.stdout.write(s.version); else process.exitCode=1;} else process.stdout.write(s.query+(s.installed?s.packages.map(p=>p.name+'\\t'+p.version+'\\t'+p.arch+'\\tinstalled\\n').join(''):''));}
else if(tool==='dpkg-deb') {const p=JSON.parse(fs.readFileSync(a.at(-1))); console.log(p.name+'\\t'+p.version+'\\t'+p.arch);}
else if(tool==='apt-get') {
 if(a.includes('--simulate')) { if(a[a.indexOf('-c')+1] !== '/proc/self/fd/8' || fs.readFileSync('/proc/self/fd/8','utf8') !== '#clear DPkg::Pre-Install-Pkgs;\\n') throw new Error('missing read-only local policy'); process.stdout.write(s.sim); }
 else {
  s.install_calls++; s.last_args=a;
  const local=a[a.indexOf('-c')+1]; if(local!=='/proc/self/fd/8' || fs.readFileSync(local,'utf8')!=='#clear DPkg::Pre-Install-Pkgs;\\n') throw new Error('missing process-local hook isolation');
  s.stock_hook_suppressed=s.config.includes('/usr/sbin/dpkg-preconfigure --apt || true'); fs.writeFileSync(state,JSON.stringify(s));
  const h=a.find(x=>x.startsWith('DPkg::Pre-Install-Pkgs::=')); if(!h) throw new Error('missing archive gate');
  if(s.root_drift) fs.appendFileSync(root+'/var/lib/apt/lists/index','drift');
  const ps=[...s.packages,...(s.extra?[{name:'unapproved',version:'1',arch:'amd64'}]:[])];
  const files=ps.map(p=>{const file=root+'/var/cache/apt/archives/'+p.name+'.deb'; fs.writeFileSync(file,JSON.stringify(p),{mode:0o644}); return file});
  const out=cp.spawnSync('/bin/sh',['-c',h.slice('DPkg::Pre-Install-Pkgs::='.length)],{input:files.join('\\n')+'\\n',env:process.env});
  if(out.status!==0) {process.stderr.write(out.stderr);process.exit(41)}
  s.installed=true; if(s.post_drift) s.query='basepkg\\t2\\tamd64\\tinstalled\\n'; fs.writeFileSync(state,JSON.stringify(s));
 }
} else throw new Error('unexpected APT command');
`);
  for (const tool of ['apt-get', 'apt-cache', 'apt-config', 'dpkg', 'dpkg-query', 'dpkg-deb']) fs.writeFileSync(root + '/usr/bin/' + tool, '#!/bin/sh\nexec ' + q(process.execPath) + ' ' + q(cli) + ' ' + q(tool) + ' ' + q(state) + ' ' + q(root) + ' "$@"\n', { mode: 0o755 });
  fs.writeFileSync(root + '/usr/bin/timeout', '#!/bin/sh\nexec /usr/bin/timeout "$@"\n', { mode: 0o755 });
  fs.writeFileSync(root + '/usr/bin/env', '#!/bin/sh\nexec /usr/bin/env "$@"\n', { mode: 0o755 });
  for (const tool of ['http', 'https', 'gpgv', 'store']) fs.writeFileSync(root + '/usr/lib/apt/methods/' + tool, 'fixture method');
  fs.writeFileSync(path.join(f.bin, 'stat'), `#!/bin/sh\nlast=''; for x in "$@"; do last=$x; done\ncase "$last" in ${q(root)}/*) /usr/bin/stat "$@" | sed 's/^${process.getuid()}:/0:/;s/^${process.getuid()}$/0/';; *) exec /usr/bin/stat "$@";; esac\n`, { mode: 0o700 });
  const observe = () => { const r = spawnSync('/bin/sh', ['-c', rewrite(deploymentAptScript())], { env: { PATH: f.bin + ':/usr/bin:/bin' }, encoding: 'utf8' }); if (r.status !== 0) throw new Error('fixture observer failed: ' + r.stderr); return r.stdout; };
  const change = patch => fs.writeFileSync(state, JSON.stringify({ ...JSON.parse(fs.readFileSync(state)), ...patch }));
  const adapter = c => {
    const spec = deploymentSystemSpecification({ id: c.id, uid: c.plan.target.uid, sleep_path: '/usr/bin/sleep', git_candidate: version, git_transaction: c.plan.system.git_transaction }), meta = c.plan.system_setup.git_install, calls = [];
    const ctl = root + '/usr/bin/systemctl';
    // Only rewrite the wrapper; the unit file is stored byte-for-byte so its
    // original SHA remains meaningful. Its fixed ExecStart is decoded separately.
    const execute = source => { const safe = rewrite(source).replace('= 0:755 ]', '= 0:755 ]'); return spawnSync('/bin/sh', ['-c', safe], { env: { PATH: f.bin + ':/usr/bin:/bin', LUSH_INSTALLER_INVOCATION: 'a'.repeat(32) }, encoding: 'utf8' }); };
    fs.writeFileSync(ctl, '#!/bin/sh\ncase "$1" in show) case "$2" in --property=LoadState) echo not-found;; --property=DropInPaths) '+(JSON.parse(fs.readFileSync(state)).dropin?'echo unknown.conf':':')+';; --property=FragmentPath) echo '+q(root+meta.unit_path)+';; *) exit 1;; esac;; daemon-reload) :;; --wait) exit 0;; *) exit 1;; esac\n', { mode: 0o755 });
    return { calls,
      spawn_process(command, args, options) {
        calls.push([command, ...args]); let output = '', code = 0, s = JSON.parse(fs.readFileSync(state));
        if (command === '/usr/bin/env') output = observe();
        else if (command === '/usr/bin/dpkg-query') { if(s.installed) output = version; else code = 1; }
        else if (command === '/usr/bin/systemctl') {
          if(args[0] === '--version') output = 'systemd 254 fixture\n';
          else output = !s.unit_started ? 'LoadState=not-found\n' : 'LoadState=loaded\nFragmentPath='+meta.unit_path+'\nUser=0\nType=exec\nExitType=cgroup\nKillMode=control-group\nDropInPaths=\nActiveState='+(s.unit_active?'active':'inactive')+'\nSubState='+(s.unit_active?'running':'dead')+'\nMainPID='+(s.unit_active&&!s.after_main?'9':'0')+'\nControlGroup='+(s.unit_active?'/system.slice/'+meta.unit_name:'')+'\nResult='+(s.root_status?'exit-code':'success')+'\nExecMainCode=1\nExecMainStatus='+(s.root_status||0)+'\nInvocationID='+ (s.gc?'':'a'.repeat(32))+'\nExecMainStartTimestampMonotonic='+(s.gc?'0':'1')+'\nExecMainExitTimestampMonotonic='+(s.gc?'0':'2')+'\n';
        } else if(command === '/usr/bin/sudo') {
          if(args.at(-1)!==spec.git_script) throw new Error('unexpected privileged script');
          // Publish original metadata through the real exclusive publication
          // wrapper; its systemctl is inert. Execute only isolated fixed script.
          const marker='LCM_UNIT_BYTES', wait=spec.git_script.indexOf('/usr/bin/systemctl --wait start'), safe=spec.git_script.slice(0,wait).replace(q(spec.git_unit_text), q(marker));
          const published=execute(safe); code=published.status || 0;
          if(code===0) {
            fs.writeFileSync(root+meta.unit_path,spec.git_unit_text); change({unit_started:true});
            const line=spec.git_unit_text.split('\n').find(x=>x.startsWith('ExecStart=')), encoded=line.slice(line.indexOf(' /bin/sh -c ')+' /bin/sh -c '.length);
            const script=JSON.parse(encoded).replaceAll('$$','$').replaceAll('%%','%');
            const ran=execute(script); code=ran.status || 0;
            if(code!==0) output=ran.stderr;
            else { const barrier=execute(spec.git_script.slice(wait)); code=barrier.status || 0; if(code) output=barrier.stderr; }
            change({root_status:code,root_diagnostic:output});
            if (!code && JSON.parse(fs.readFileSync(state)).drop_ack) code=91;
          }
        } else throw new Error('unexpected command');
        return spawn('/bin/sh', ['-c', 'printf %s ' + q(output) + '; exit ' + code], options);
      },
      readInstallerUnit: async () => sha(fs.readFileSync(root + meta.unit_path)),
      readInstallerObservation: async () => fs.existsSync(root + meta.observation_path) ? fs.readFileSync(root + meta.observation_path, 'utf8') : null,
    };
  };
  return { root, state, rewrite, observe, change, stock() { fs.mkdirSync(root+'/etc/apt/apt.conf.d'); fs.writeFileSync(root+'/etc/apt/apt.conf.d/70debconf',fs.readFileSync(new URL('./fixtures/runner-deployment-remote-debian/70debconf.conf',import.meta.url))); fs.mkdirSync(root+'/etc/dpkg/dpkg.cfg.d'); fs.writeFileSync(root+'/etc/dpkg/dpkg.cfg','no-debsig\nlog '+root+'/var/log/dpkg.log\n'); change({config:'APT::Architecture "amd64";\nDir "/";\nDir::State "var/lib/apt";\nDir::State::status "/var/lib/dpkg/status";\nDir::Cache "var/cache/apt";\nDir::Etc "etc/apt";\nDPkg::Pre-Install-Pkgs "";\nDPkg::Pre-Install-Pkgs:: "/usr/sbin/dpkg-preconfigure --apt || true";\nDPkg::Tools::Options::/usr/sbin/dpkg-preconfigure::Version "2";\n'}); }, script: () => rewrite(deploymentAptScript()), transaction: () => parseDeploymentApt(observe()), adapter };
}
