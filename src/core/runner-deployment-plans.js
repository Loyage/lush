import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readSshAliases } from './runner-ssh.js';
import { DeploymentStore } from './runner-deployment-store.js';
import { DeploymentOperations } from './runner-deployment-operations.js';
import { DeploymentRemote, buildDeploymentSystemPlan, deploymentAbiEvidence } from './runner-deployment-remote.js';
import { buildOfficialDeploymentArtifacts } from './runner-deployment-bundle.js';
import { RunnerSettings, normalizeRunnerNode } from './runner-settings.js';
import { publicDeployment, validateDeploymentApproval, validateDeploymentRequest } from './runner-deployment-view.js';
import { hash, stable } from '../runner/protocol.js';
import { check } from './types.js';

// Frozen, deliberately small first-deployment budgets; not current/default project settings.
export const DEPLOYMENT_NODE_BUDGETS = Object.freeze({ max_commands: 1, timeout_ms: 60000, output_bytes: 1048576 });
const labels = { node_register: '登记禁用且未固定身份的新节点', credentials_pair: '生成并配对独立机器与项目凭据',
  install_runtime: '上传固定校验的 Bun 运行时', install_runner: '上传固定 Runner 生产文件',
  configure_runner: '新增私有配置与安装完整性清单', verify_runner: '真实握手、Bun/FFI 执行、取消与完整停止验证',
  git_install: '安装完整固定 Git 新增依赖事务', cgroup_setup: '建立专属 systemd 委派与空 Runner 子组' };
const action = (id, metadata = {}) => ({ id, label: labels[id], privileged: ['git_install', 'cgroup_setup'].includes(id), ...metadata });
const artifactMetadata = value => Object.fromEntries(['version', 'source', 'os', 'arch', 'sha256', 'size'].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
const safeSystemMetadata = value => Object.fromEntries(['unit_path', 'unit_sha256', 'unit_summary', 'effect', 'packages', 'packages_truncated'].filter(key => value?.[key] !== undefined).map(key => [key, structuredClone(value[key])]));

/** Pure trusted composition. No scripts, artifact local paths or plaintext credentials in the plan.
 * Full private target/ABI/system observations are frozen in the same digest as the public preview.
 */
export function freezeDeploymentPlan({ id, request, bundle, probe, ssh_sha256, nodes }) {
  const blockers = [], block = (code, message) => blockers.push({ code, message });
  const target = probe.target, abi = deploymentAbiEvidence(bundle.runtime.abi);
  const node = normalizeRunnerNode({ id, name: request.name, ssh_alias: request.ssh_alias, enabled: false, budgets: DEPLOYMENT_NODE_BUDGETS });
  check(Array.isArray(bundle.files) && bundle.files.length > 0 && bundle.files.length <= 509 && new Set(bundle.files).size === bundle.files.length
    && bundle.files.every(file => typeof file === 'string' && /^[A-Za-z0-9_.+-]+(?:\/[A-Za-z0-9_.+-]+)*$/.test(file) && !file.split('/').some(part => ['.', '..'].includes(part))), 'Incomplete deployment bundle preview');
  if (target.os !== 'linux' || !Number.isSafeInteger(target.uid) || target.uid <= 0 || target.os !== bundle.runtime.os || target.arch !== bundle.runtime.arch) block('platform_unsupported', '目标必须为非 root 的匹配 Linux/CPU 平台');
  if (bundle.runtime.abi.supported !== true || probe.abi.status !== 'ready' || probe.remote.abi_sha256 !== hash(JSON.stringify(abi))) block('abi_unsupported', '尚未取得与固定运行时匹配的完整 ABI/CPU 证据');
  if (probe.install.exists || probe.install.managed || probe.install.legacy) block('installation_exists', '此 SSH 账户已有安装；不重装、升级或认领，请处理原安装');
  if (probe.pending.exists) block('remote_operation_unresolved', '此目标存在已有或未知部署保护；不得另建计划绕过');
  if (nodes.some(item => item.id === id || item.ssh_alias === request.ssh_alias)) block('node_exists', '此别名已有中央节点；不采用已有节点或凭据');
  if (nodes.length >= 64) block('node_limit', '中央节点数量已达上限');
  let system_setup = null;
  try { system_setup = buildDeploymentSystemPlan({ id, target, system: probe.system }); }
  catch { block('system_plan_unsupported', '无法完整固定系统准备动作；请人工准备后重新检查'); }
  const actions = [action('node_register'), action('credentials_pair'), action('install_runtime'), action('install_runner')];
  const git = probe.dependencies.find(item => item.name === 'Git');
  if (git?.status === 'needs_install') {
    if (!probe.system.sudo_git_n || !system_setup?.git_install) block('git_install_unavailable', '缺少可非交互执行的完整固定 Git 事务或独立系统权限');
    else actions.push(action('git_install', safeSystemMetadata(system_setup.git_install)));
  } else if (git?.status !== 'ready') block('git_unsupported', 'Git 未就绪且当前系统策略不支持完整安全自动安装');
  if (probe.cgroup.status === 'needs_setup') {
    if (!probe.system.sudo_n || probe.system.systemd < 254 || !system_setup?.cgroup_setup) block('cgroup_setup_unavailable', '需要 systemd ≥254、可信系统工具与独立非交互 sudo 权限');
    else actions.push(action('cgroup_setup', safeSystemMetadata(system_setup.cgroup_setup)));
  } else if (probe.cgroup.status !== 'ready') block('cgroup_unsupported', '需要已验证专属委派或受支持的显式系统准备');
  actions.push(action('configure_runner'), action('verify_runner'));
  const plan = { target: structuredClone(target), install_root: probe.install_root, runtime: artifactMetadata(bundle.runtime), runner: artifactMetadata(bundle.runner),
    files: ['bun', ...bundle.files.map(file => `runner/${file}`), 'config.json', 'manifest.json'], node_budgets: node.budgets,
    actions, dependencies: structuredClone(probe.dependencies), cgroup: structuredClone(probe.cgroup),
    abi, remote: structuredClone(probe.remote), ssh_config_sha256: ssh_sha256, system: structuredClone(probe.system), system_setup,
    blockers, supported: blockers.length === 0 };
  if (plan.supported) validateDeploymentApproval(plan, actions.map(item => item.id));
  return plan;
}

/** Private central plan lifecycle, not a public dispatch surface. No reads/downloads on construction.
 * Artifacts survive only this process; journaled metadata must never become a durable local-path lease.
 */
export class DeploymentPlans {
  #artifacts = new Map(); #closed = false;
  constructor(config, { store = new DeploymentStore(config), operations = new DeploymentOperations(store), settings = new RunnerSettings(config),
    snapshot = () => readSshAliases(), build_artifacts = () => buildOfficialDeploymentArtifacts({ allow_download: true }),
    remote_factory = options => new DeploymentRemote(options) } = {}) {
    this.store = store; this.operations = operations; this.settings = settings;
    this.snapshot = snapshot; this.build_artifacts = build_artifacts; this.remote_factory = remote_factory;
  }
  get pending() { return this.operations.pending; }
  read() { return this.store.list(); }
  currentSnapshot() {
    const value = this.snapshot();
    check(value && typeof value.configuration === 'string' && (value.status === 'missing' || value.status === 'ok' && !value.limited), 'SSH configuration cannot be completely and safely evaluated');
    return value.configuration;
  }
  async plan(request) {
    check(!this.#closed, 'Deployment service is closed');
    validateDeploymentRequest('runner.deployments.plan', request);
    const configuration = this.currentSnapshot(), id = randomUUID();
    const initial = this.store.create({ id, status: 'planned', ssh_alias: request.ssh_alias, name: request.name, project_id: request.project_id,
      plan: {}, stages: [], private_data: { ssh_configuration: configuration, ssh_sha256: hash(configuration) } });
    let bundle, remote, keep = false;
    try {
      const result = await this.operations.run(id, initial.revision, { stages: ['prepare_artifacts', 'probe'], finish: row => row.plan.supported ? 'planned' : 'blocked' }, async context => {
        bundle = await context.stage('prepare_artifacts', async () => {
          const value = await this.build_artifacts();
          bundle = value; context.guard(); return value;
        });
        context.guard();
        remote = this.remote_factory({ ssh_alias: request.ssh_alias, ssh_configuration: configuration });
        context.onClose(() => remote.close());
        const probe = await context.stage('probe', () => remote.probe({ id, abi: bundle.runtime.abi }));
        context.guard();
        check(this.currentSnapshot() === configuration, 'SSH configuration changed during deployment inspection');
        const plan = freezeDeploymentPlan({ id, request, bundle, probe, ssh_sha256: hash(configuration), nodes: this.settings.read().nodes });
        context.checkpoint(row => {
          row.plan = plan; row.private_data.remote = structuredClone(probe.remote);
          row.private_data.plan_proof = hash(stable(probe)); row.private_data.plan_sha256 = hash(stable(plan));
        });
      });
      keep = result.status === 'planned' && result.plan.supported === true && !this.#closed;
      if (keep) this.#artifacts.set(id, bundle);
      return publicDeployment(this.operations.view(result));
    } finally { if (bundle && !keep) bundle.cleanup(); }
  }
  /** Exact approved process-local snapshot only; no recovery rebuild, upload or permission repair. */
  artifacts(record) {
    check(!this.#closed, 'Deployment service is closed');
    const value = this.#artifacts.get(record.id);
    check(value && record.private_data.plan_sha256 === hash(stable(record.plan))
      && stable(artifactMetadata(value.runtime)) === stable(record.plan.runtime) && stable(artifactMetadata(value.runner)) === stable(record.plan.runner)
      && stable(deploymentAbiEvidence(value.runtime.abi)) === stable(record.plan.abi)
      && stable(['bun', ...value.files.map(file => `runner/${file}`), 'config.json', 'manifest.json']) === stable(record.plan.files),
    'Approved temporary artifact snapshot is unavailable or changed; no action was sent');
    // All local bytes must be usable BEFORE remote prepare/central registration; upload checks again.
    for (const kind of ['runtime', 'runner']) {
      let fd;
      try {
        const artifact = value[kind];
        check(typeof artifact.file === 'string' && path.isAbsolute(artifact.file) && path.normalize(artifact.file) === artifact.file
          && fs.realpathSync(artifact.file) === artifact.file, 'Deployment artifact snapshot path changed');
        fd = fs.openSync(artifact.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const before = fs.fstatSync(fd), sum = createHash('sha256'), bytes = Buffer.alloc(1024 * 1024); let count, size = 0;
        check(before.isFile() && before.uid === process.getuid() && before.nlink === 1 && (before.mode & 0o077) === 0 && before.size === artifact.size, 'Deployment artifact snapshot changed');
        while ((count = fs.readSync(fd, bytes, 0, bytes.length, null))) { size += count; check(size <= artifact.size, 'Deployment artifact snapshot changed'); sum.update(bytes.subarray(0, count)); }
        const after = fs.fstatSync(fd), name = fs.lstatSync(artifact.file);
        check(size === artifact.size && sum.digest('hex') === artifact.sha256 && !name.isSymbolicLink()
          && ['dev', 'ino', 'mtimeMs', 'ctimeMs', 'size'].every(key => before[key] === after[key] && before[key] === name[key]), 'Deployment artifact snapshot changed');
      } catch { throw new Error('Approved temporary artifact bytes are unavailable or changed; no action was sent'); }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    return value;
  }
  release(id) {
    const value = this.#artifacts.get(id);
    if (value) { value.cleanup(); this.#artifacts.delete(id); }
  }
  async close() {
    this.#closed = true;
    await this.operations.close();
    for (const id of this.#artifacts.keys()) this.release(id);
  }
}
