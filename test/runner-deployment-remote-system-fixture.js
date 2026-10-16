import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deploymentSystemSpecification } from '../src/core/runner-deployment-remote-system.js';

// All privilege and cgroup observations are simulations. The fixed root script is
// actually executed as the current unprivileged user after rewriting EVERY system
// write path into this fixture, replacing only the fixed systemctl/apt adapters.
export function systemFixture(f, c, options = {}) {
  const root = path.join(f.root, 'system-adapter'); fs.mkdirSync(root, { mode: 0o700 });
  const system = path.join(root, 'units'); fs.mkdirSync(system, { mode: 0o755 }); fs.chmodSync(system, 0o755); fs.mkdirSync(path.join(system, 'multi-user.target.wants'));
  const spec = deploymentSystemSpecification({ id: c.id, uid: c.plan.target.uid, sleep_path: '/usr/bin/sleep', git_candidate: c.plan.system.git_candidate });
  const state = path.join(root, 'state.json'), calls = [];
  fs.writeFileSync(state, JSON.stringify({ installed: false, git: null, active: false, fail: options.fail_after_unit || false }), { mode: 0o600 });
  const q = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
  const ctl = path.join(root, 'systemctl');
  fs.writeFileSync(ctl, `#!/bin/sh
case "$1" in
 show) case "$2" in --property=LoadState) echo not-found;; --property=DropInPaths) ${options.dropin ? 'echo unknown.conf' : ':'};; --property=FragmentPath) echo ${q(path.join(system, spec.plan.unit.name))};; *) exit 9;; esac;;
 daemon-reload) ${options.fail_after_unit ? 'exit 7' : ':'};;
 enable) ln -s ${q(path.join(system, spec.plan.unit.name))} ${q(path.join(system, 'multi-user.target.wants', spec.plan.unit.name))};;
 start) :;;
 *) exit 9;;
esac
`, { mode: 0o700 });
  const aptcache = path.join(root, 'apt-cache'), aptget = path.join(root, 'apt-get');
  fs.writeFileSync(aptcache, '#!/bin/sh\nprintf "Candidate: %s\\n" ' + q(c.plan.system.git_candidate) + '\n', { mode: 0o700 });
  fs.writeFileSync(aptget, '#!/bin/sh\n[ "$*" = ' + q(`-y --no-install-recommends --no-remove install git=${c.plan.system.git_candidate}`) + ' ]\n', { mode: 0o700 });
  const child = path.join(root, 'command.js');
  fs.writeFileSync(child, `import fs from 'node:fs'; import cp from 'node:child_process';
const input=JSON.parse(process.argv[2]), stateFile=process.argv[3], root=process.argv[4], expected=JSON.parse(process.argv[5]);
const state=JSON.parse(fs.readFileSync(stateFile)); const [cmd,...args]=input;
if(cmd==='/usr/bin/systemctl') {
 if(args[0]==='--version') console.log('systemd 254 (fixture)');
 else if(args[0]==='show') {
  if(args[1]===expected.unit.name && fs.existsSync(root+'/units/'+expected.unit.name)) {
   console.log('LoadState=loaded\\nActiveState='+ (state.active?'active':'inactive') +'\\nSubState=running\\nFragmentPath='+expected.unit.path+'\\nUser='+expected.unit.uid+'\\nDelegate=yes\\nDelegateSubgroup=supervisor\\nControlGroup=/fixture.slice/'+expected.unit.name+'\\nMainPID=98765\\nDropInPaths=\\nExecStart={ path=/usr/bin/sleep ; argv[]=/usr/bin/sleep infinity ; ignore_errors=no ; }');
  } else console.log('LoadState=not-found\\nActiveState=inactive');
 } else process.exitCode=7;
} else if(cmd==='/usr/bin/apt-cache') console.log('  Candidate: '+expected.git.candidate);
else if(cmd==='/usr/bin/dpkg-query') { if(state.git) process.stdout.write(state.git); else process.exitCode=1; }
else if(cmd==='/usr/bin/sudo') {
 if(${options.denied ? 'true' : 'false'}) process.exit(1);
 const script=args.at(-1), isGit=script===${JSON.stringify(spec.git_script)}, isCgroup=script===${JSON.stringify(spec.cgroup_script)};
 if(!isGit&&!isCgroup) throw new Error('unexpected root script');
 const safe=script.replaceAll('/etc/systemd/system',root+'/units').replaceAll('/run/systemd/system',root+'/runtime-units').replaceAll('/usr/lib/systemd/system',root+'/vendor-units').replaceAll('/lib/systemd/system',root+'/lib-units').replaceAll('/usr/bin/systemctl',root+'/systemctl').replaceAll('/usr/bin/apt-cache',root+'/apt-cache').replaceAll('/usr/bin/apt-get',root+'/apt-get').replaceAll('/usr/bin/git',root+'/missing-git').replaceAll('/bin/git',root+'/missing-git').replace('[ "$(id -u)" = 0 ]','[ "$(id -u)" = '+process.getuid()+' ]').replace('= 0:755 ]','= '+process.getuid()+':755 ]');
 const ran=cp.spawnSync('/bin/sh',['-c',safe],{stdio:['ignore','pipe','pipe']}); fs.writeFileSync(root+'/last-script',safe); state.last_error=ran.stderr.toString(); state.last_status=ran.status;
 state.installed=fs.existsSync(root+'/units/'+expected.unit.name); if(ran.status===0) { if(isGit) state.git=expected.git.candidate; else state.active=true; } fs.writeFileSync(stateFile,JSON.stringify(state));
 process.exitCode=ran.status||0;
} else throw new Error('Unexpected privileged adapter command');
`);
  let drift = false;
  const evidence = parent => ({ path: parent + '/runner', evidence: { unit: spec.plan.unit.name, control_group: parent.slice('/sys/fs/cgroup'.length), delegated_parent: parent, parent_dev: '1', parent_ino: '2', dev: '3', ino: '4', boot_id: c.plan.remote.boot_id, fragment_path: spec.plan.unit.path, unit_sha256: c.plan.system_setup.unit.sha256, sleep_path: '/usr/bin/sleep', systemctl_path: '/usr/bin/systemctl' } });
  return { calls, state, unit_file: path.join(system, spec.plan.unit.name), drift(value) { drift = value; },
    spawn_process(command, args, spawnOptions) { calls.push([command, ...args]); return spawn(process.execPath, [child, JSON.stringify([command, ...args]), state, root, JSON.stringify(spec.plan)], spawnOptions); },
    readUnit() { return createHash('sha256').update(fs.readFileSync(path.join(system, spec.plan.unit.name))).digest('hex'); },
    bindCgroup: async parent => evidence(parent),
    verifyCgroup: async (path, observed) => !drift && path.endsWith('/runner') && observed.ino === '4',
  };
}
