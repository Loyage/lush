// Native uploaded-production FAIL-CLOSED fixture. Not a simulated successful
// Runner/cgroup chain: no fake protocol, process-group adapter or fabricated seal.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { buildOfficialDeploymentArtifacts } from '../src/core/runner-deployment-bundle.js';
import { OFFICIAL_BUN } from '../src/core/runner-deployment-official.js';
import { managedRunnerArguments, managedRecoveryRunnerArguments } from '../src/core/runner-deployment-remote.js';
import { managedProgramCommand } from '../src/core/runner-deployment-remote-launch.js';
import { remoteRuntime } from '../src/core/runner-deployment-remote-runtime.js';
import { verifyDeploymentRunner } from '../src/core/runner-deployment-verify.js';
import { StdioTransport } from '../src/runner/transport.js';
import { remoteFixture, digest } from './runner-deployment-remote-fixture.js';

export function observeHostDelegation() {
  const root = `/sys/fs/cgroup/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service`;
  const writable = file => { try { fs.accessSync(file, fs.constants.W_OK); return true; } catch { return false; } };
  return { uid: process.getuid(), directory_exists: fs.existsSync(root), procs_writable: writable(root + '/cgroup.procs'),
    kill_writable: writable(root + '/cgroup.kill'), existing_runner_child: fs.existsSync(root + '/lush-runner') };
}

/** Internal test seam for a parent integration fixture. Explicit ZIP is required;
 * never fetch, alter pins, change production files or touch real system cgroups.
 * The synthetic cgroup is ONLY a configure/launch observation adapter. Actual
 * uploaded createRunnerNode and command-child attach remain unmodified/strict.
 */
export async function uploadedProductionFixture({ official_zip }) {
  if (!official_zip) throw new Error('An explicitly supplied verified official ZIP is required');
  const f = remoteFixture(), transports = [], sessions = []; let bundle;
  const close = async () => { try { await Promise.all(transports.map(t => t.close())); } finally { try { bundle?.cleanup(); } finally { await f.close(); } } };
  try {
    const cache = path.join(f.root, 'official-cache'); fs.mkdirSync(cache, { mode: 0o700 });
    const cached = path.join(cache, OFFICIAL_BUN.archive_sha256 + '.zip'); fs.copyFileSync(official_zip, cached); fs.chmodSync(cached, 0o600);
    bundle = await buildOfficialDeploymentArtifacts({ cache_directory: cache, destination: f.root, allow_download: false });
    const remote = f.remote(), id = randomUUID(), probe = await remote.probe({ id, abi: bundle.runtime.abi });
    if (probe.abi.status !== 'ready') throw new Error('Actual official ABI probe is unsupported; no synthetic ABI evidence is permitted');
    const parent = '/sys/fs/cgroup/lush-test-unavailable-' + id;
    if (fs.existsSync(parent)) throw new Error('Isolated fixture cgroup path unexpectedly exists');
    const plan = { target: probe.target, remote: probe.remote, abi: bundle.runtime.abi, ssh_config_sha256: remote.configuration_sha256,
      install_root: probe.install_root, runtime: bundle.runtime, runner: bundle.runner, files: bundle.files, actions: [],
      cgroup: { status: 'ready', path: parent + '/lush-runner', evidence: { boot_id: probe.remote.boot_id, dev: '1', ino: '2',
        unit: `user@${probe.target.uid}.service`, control_group: parent.slice('/sys/fs/cgroup'.length), delegated_parent: parent } } };
    const request = { id, plan, plan_sha256: digest(JSON.stringify(plan)) };
    await remote.prepare(request);
    // Real verified bytes travel over the actual production stdin/upload/source
    // framing. Never copy a runtime into place or manually mark upload receipts.
    const runtime = await remote.upload({ ...request, kind: 'runtime', artifact: bundle.runtime });
    const runner = await remote.upload({ ...request, kind: 'runner', artifact: { ...bundle.runner, files: bundle.files } });
    const auth = { machine_token: randomBytes(32).toString('hex'), control_token: randomBytes(32).toString('hex') }, project_id = 'uploaded-production-test';
    const node_config = { version: 1, node_id: randomUUID(), root: plan.install_root + '/workspaces', cgroup_root: plan.cgroup.path,
      machine_token_hash: digest(auth.machine_token), projects: { [project_id]: { control_token_hash: digest(auth.control_token) } } };
    // Trusted test-only observation allows writing a CONFIGURED fixture, NOT a
    // verified/sealed installation. No forged Runner proof or candidate is made.
    const configured = await remoteRuntime({ ...request, operation: 'configure', node_config }, { verifyCgroup: p => p === plan.cgroup.path });
    if (!configured.ok) throw new Error('Native fixture configure was not confirmed');
    const managed = remote.describe(request, configured.managed), ssh = { ssh_alias: 'fixture', ssh_configuration_file: path.join(remote.directory, 'config') };
    const shim = path.join(f.root, 'isolated-ssh'), marker = path.join(f.root, 'native-exec-admitted');
    fs.writeFileSync(shim, '#!/bin/sh\nset -eu\nfor argument do command=$argument; done\nexec /bin/sh -c "$command"\n', { mode: 0o700 });
    const original = () => Object.fromEntries(['bun', 'manifest.json', 'config.json', ...bundle.files.map(file => 'runner/' + file)]
      .map(file => [file, digest(fs.readFileSync(path.join(plan.install_root, file)))]));
    const snapshot = original();
    // Test assertions ONLY, after native Runner/transport close. The production
    // recovery observer is not replaced and never opens its original DB this way.
    const facts = () => {
      const file = path.join(managed.root, 'runner.db'); if (!fs.existsSync(file)) return null;
      const db = new Database(file, { readonly: true });
      try { return { runner_id: db.query("SELECT value FROM node_metadata WHERE key='runner_id'").get().value,
        workspaces: db.query('SELECT count(*) n FROM workspaces').get().n, commands: db.query('SELECT count(*) n FROM executions').get().n }; }
      finally { db.close(); }
    };
    function transport({ provisional = null, observe_launcher_cgroup = false } = {}) {
      const args = provisional ? managedRecoveryRunnerArguments({ ...ssh, managed, ...provisional }) : managedRunnerArguments({ ...ssh, managed });
      let command = args.at(-1);
      if (observe_launcher_cgroup) {
        // Do NOT supply start(), mock any module, replace the uploaded entry,
        // patch cgroup preflight/attach or synthesize a protocol response.
        const changed = command.replace('{held_fd:8', `{held_fd:8,verifyCgroup:p=>p===${JSON.stringify(managed.cgroup_root)}`);
        if (changed === command) throw new Error('Explicit launch observation adapter was not installed'); command = changed;
      }
      // Expose ONLY the known safe error code from the native generated catch.
      // No raw diagnostics or protocol result is synthesized; all guards and
      // uploaded functions are unchanged, and the command still exits nonzero.
      command = command.replace('.catch(() => { process.stderr.write(', '.catch(error => { if(error.code === "UNSUPPORTED") process.stderr.write("NATIVE_UPLOADED_UNSUPPORTED\\n"); process.stderr.write(');
      // Observational marker immediately before env/Bun exec, AFTER the actual
      // shell admission and verified FD9 gates. No arbitrary request selects it.
      command = command.replace('exec /usr/bin/env -i ', `printf admitted > ${marker}\nexec /usr/bin/env -i `);
      const t = new StdioTransport({ command: shim, args: [...args.slice(0, -1), command], env: { PATH: '/usr/bin:/bin', HOME: f.home }, request_ms: 2000 });
      let diagnostic = ''; t.child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-256); });
      t.fixture_unsupported = () => diagnostic.includes('NATIVE_UPLOADED_UNSUPPORTED');
      t.fixture_ssh_args = args; transports.push(t); return t;
    }
    async function verify(options = {}) {
      const session = { methods: [], responses: [], events: [], request_timeouts: [], exit: null }; sessions.push(session); let connection;
      return await verifyDeploymentRunner({ deployment_id: id, node_id: managed.node_id, project_id, runtime_path: managed.install_root + '/bun',
        runtime_version: OFFICIAL_BUN.version, implementation_version: bundle.runner.version, arch: probe.target.arch, auth,
        expected_runner_id: options.expected_runner_id ?? null, timeout_ms: 8000, guard() {}, checkpoint(event) { session.events.push(event); },
        transport_factory() { connection = transport(options); return { async request(frame, opts) {
          const timeout_ms = Math.min(2000, opts?.timeout_ms ?? 2000); session.request_timeouts.push(timeout_ms);
          session.methods.push(frame.method); const response = await connection.request(frame, { ...opts, timeout_ms }); session.responses.push(response.error?.code ?? 'result'); return response;
        }, async close() { session.exit = await connection.close(); session.unsupported = connection.fixture_unsupported(); } }; } });
    }
    const probeUploadedEntry = async () => {
      const program = `(async()=>{const e=await import(${JSON.stringify(managed.install_root + '/runner/src/runner/index.js')});let n;try{n=await e.createRunnerNode(e.readRunnerConfig(${JSON.stringify(managed.config_file)}));console.log(JSON.stringify({ok:true}));}catch(e){console.log(JSON.stringify({ok:false,code:e.code==="UNSUPPORTED"?"UNSUPPORTED":"other"}));}finally{await n?.close();}})();`;
      return JSON.parse(await remote.run(managedProgramCommand(managed, program)));
    };
    const probeHostDelegation = async () => {
      // The REAL host's known manager root is observed only, never adopted or
      // mutated. Even a successful read-only preflight would not authorize using
      // a manager node instead of an independently verified dedicated child.
      const root = `/sys/fs/cgroup/user.slice/user-${probe.target.uid}.slice/user@${probe.target.uid}.service`;
      const program = `(async()=>{const {createCgroupController}=await import(${JSON.stringify(managed.install_root + '/runner/src/runner/cgroup.js')});try{createCgroupController({cgroup_root:${JSON.stringify(root)},node_id:${JSON.stringify(managed.node_id)}}).preflight();console.log(JSON.stringify({code:"available-observation-only"}));}catch(e){console.log(JSON.stringify({code:e.code==="UNSUPPORTED"?"UNSUPPORTED":"other"}));}})();`;
      return JSON.parse(await remote.run(managedProgramCommand(managed, program)));
    };
    const probeUploadedAttach = () => {
      const payload_marker = path.join(f.root, 'UNEXPECTED-payload-ran'), program = `require("node:fs").writeFileSync(${JSON.stringify(payload_marker)},"unexpected")`;
      const input = JSON.stringify({ spec: { cgroup_root: managed.cgroup_root, node_id: managed.node_id, argv: [managed.install_root + '/bun', '-e', program], cwd: '.', env: {} },
        receipt: {}, workspace: { directory: managed.root }, home: managed.root }) + '\n';
      const child = spawnSync(managed.install_root + '/bun', ['--no-install', '--no-env-file', '--config=/dev/null', managed.install_root + '/runner/src/runner/command-child.js'],
        { input, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: f.home }, timeout: 2000, maxBuffer: 65536 });
      return { code: child.status, signal: child.signal, error: child.error?.code ?? null, stdout: child.stdout, stderr: child.stderr, payload_ran: fs.existsSync(payload_marker) };
    };
    return { root: f.root, home: f.home, bundle, remote, request, probe, managed, auth, project_id, ssh, marker, runtime, runner,
      snapshot, original, facts, transport, verify, sessions, probeUploadedEntry, probeHostDelegation, probeUploadedAttach, close };
  } catch (error) { await close(); throw error; }
}
