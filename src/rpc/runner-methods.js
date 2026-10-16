import { check, isPlainObject, LushError } from '../core/types.js';
import { LIMITS, CAPABILITIES } from '../runner/protocol.js';
import { normalizeRunnerNode } from '../core/runner-settings.js';
import { validateRunnerControlToken } from '../core/runner-credentials.js';
import { safeSshAlias } from '../core/runner-ssh.js';
import { publicDeployments, validateDeploymentRequest } from '../core/runner-deployment-view.js';
import { validateRecoveryRequest } from '../core/runner-deployment-recovery-view.js';

// Single registration source for RPC, CLI, HTTP allowlists and Host device-only operations.
export const RUNNER_METHODS = Object.freeze({
  'runner.deployments.get': { params: [], device: true, readPath: 'runner/deployments', cli: 'runner deployments get', description: '只读设备部署收据；不联网、安装、对账或重放未知操作。' },
  'runner.deployments.plan': { params: ['ssh_alias', 'name', 'project_id'], device: true, cli: 'runner deployments plan', file: 'runner-deployment-plan.json', advanced: '仅用户；owner-only JSON 含 ssh_alias/name/project_id，无 expected_revision。显式操作可能获取固定官方 Bun，但不安装；--scope device 不发现项目或启动 daemon。blocked/unknown 不表示可安装，未知不重试；生产 cgroup 正向链仍需隔离授权环境验收。', description: '显式准备固定可信产物并只读检查 SSH 目标；不安装、不登记节点或授项目权。' },
  'runner.deployments.apply': { params: ['id', 'expected_revision', 'approved_actions', 'confirm'], device: true, cli: 'runner deployments apply', file: 'runner-deployment-apply.json', description: '完整批准原冻结计划后安装并验证；未确认停止或 ACK 丢失保留 unknown，不重试。' },
  'runner.deployments.confirm': { params: ['id', 'expected_revision', 'runner_id', 'confirm'], device: true, cli: 'runner deployments confirm', file: 'runner-deployment-confirm.json', description: '独立核对原已验证安装，再固定原身份并启用节点；不授项目执行权。' },
  'runner.deployments.reconcile': { params: ['id', 'expected_revision'], device: true, cli: 'runner deployments reconcile', file: 'runner-deployment-reconcile.json', description: '仅观察原部署请求与部分现场；不重放安装、补确认或解除未知屏障。' },
  'runner.deployments.recovery.plan': { params: ['id', 'expected_revision'], device: true, cli: 'runner deployments recovery plan', file: 'runner-recovery-plan.json', description: '只读检查原 confirmed 安装并冻结独立运行代次恢复计划；不开始恢复。' },
  'runner.deployments.recovery.apply': { params: ['id', 'expected_revision', 'recovery_id', 'approved_actions', 'confirm'], device: true, cli: 'runner deployments recovery apply', file: 'runner-recovery-apply.json', description: '完整独立批准原恢复计划，验证原 Runner 并发布激活新代次；不清旧 slot 或 Worker/Run 屏障。' },
  'runner.deployments.recovery.reconcile': { params: ['id', 'expected_revision', 'recovery_id'], device: true, cli: 'runner deployments recovery reconcile', file: 'runner-recovery-reconcile.json', description: '仅检查原恢复请求；观察到 activated 也不补激活、发布或打开普通执行门禁。' },
  'runner.ssh.discover': { params: [], device: true, readPath: 'runner/ssh/aliases', cli: 'runner ssh discover', description: '只读当前系统用户 SSH 配置中的安全具体别名；不联网，不返回配置正文。' },
  'runner.ssh.test': { params: ['ssh_alias'], device: true, cli: 'runner ssh test', args: 'SSH_ALIAS', example: 'my-node', description: '显式测试 SSH 登录；安全配置子集、严格 host key、固定 true 命令，不保存节点或检查 Runner。' },
  'runner.worker.reconcile': { params: ['id', 'expected_revision'], cli: 'runner worker reconcile', args: 'ID --expected-revision N', example: '5 --expected-revision 3', advanced: '仅用户与所选项目；revision 来自 worker.inspect 的 runner.revision。只核验持久请求和停止证据，不自动 retry/resume，不支持 --scope device。reconciled:false 表示尚未恢复。', description: '核验固定远端现场和已登记工具收据；不重放、不重试或启动 Agent。' },
  'runner.nodes.get': { params: [], device: true, readPath: 'runner/nodes', cli: 'runner nodes get', description: '读取设备执行节点，不连接远端。' },
  'runner.nodes.set': { params: ['nodes', 'expected_revision'], device: true, cli: 'runner nodes set', file: 'runner-nodes.json', description: '按 revision 完整替换节点列表，显式保存安装身份 pin。' },
  'runner.nodes.check': { params: ['node_id', 'project_id'], device: true, cli: 'runner nodes check', description: '显式认证检查预装 Runner，只返回诊断，不自动 pin。' },
  'runner.credentials.get': { params: [], device: true, readPath: 'runner/credentials', cli: 'runner credentials get', description: '只读凭据配置状态及 revision，绝不返回秘密。' },
  'runner.credentials.set': { params: ['node_id', 'project_id', 'machine_token', 'control_token', 'expected_revision'], device: true, cli: 'runner credentials set', file: 'runner-credentials.json', description: '从私有文件保存机器或项目控制凭据。' },
  'runner.credentials.remove': { params: ['node_id', 'project_id', 'expected_revision'], device: true, cli: 'runner credentials remove', file: 'runner-remove.json', description: '按 revision 删除指定项目或节点凭据。' },
  'runner.project.get': { params: [], readPath: 'runner/project', cli: 'runner project get', description: '读取当前项目的节点授权、默认节点及稳定项目 ID。' },
  'runner.project.set': { params: ['allowed_node_ids', 'default_node_id', 'expected_revision'], cli: 'runner project set', file: 'runner-project.json', description: '按 revision 保存当前项目授权和默认节点，不迁移已有 Worker。' },
});
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
export { validateRunnerNodeSelection } from '../core/runner-selection.js';
export function validateRunnerParams(method, params) {
  const spec = RUNNER_METHODS[method];
  check(spec && isPlainObject(params) && Object.keys(params).every(key => spec.params.includes(key)), 'invalid Runner parameters');
  check(Buffer.byteLength(JSON.stringify(params)) <= 128 * 1024, 'Runner request exceeds its limit');
  if (method.startsWith('runner.deployments.recovery.')) validateRecoveryRequest(method.slice('runner.deployments.recovery.'.length), params);
  else if (method.startsWith('runner.deployments.')) validateDeploymentRequest(method, params);
  if (method === 'runner.ssh.test') check(safeSshAlias(params.ssh_alias), 'invalid SSH alias');
  if (method === 'runner.worker.reconcile') {
    check(Number.isSafeInteger(params.id) && params.id > 0 && Number.isSafeInteger(params.expected_revision) && params.expected_revision > 0,
      'Worker id and Runner binding expected_revision are required');
  }
  if (method === 'runner.nodes.set') {
    check(typeof params.expected_revision === 'string' && /^[0-9a-f]{64}$/.test(params.expected_revision), 'Runner settings revision required');
    check(Array.isArray(params.nodes) && params.nodes.length <= 64, 'invalid Runner nodes');
    params.nodes.forEach(normalizeRunnerNode);
  }
  if (method === 'runner.nodes.check' || method === 'runner.credentials.set' || method === 'runner.credentials.remove') {
    check(uuid(params.node_id), 'invalid Runner node identity');
    if (Object.hasOwn(params, 'project_id')) check(opaque(params.project_id), 'invalid Runner project identity');
  }
  if (method === 'runner.credentials.set' || method === 'runner.credentials.remove') {
    check(params.expected_revision === 'absent' || uuid(params.expected_revision), 'Runner credential revision required');
    if (method.endsWith('.set')) {
      check(Object.hasOwn(params, 'machine_token') || Object.hasOwn(params, 'project_id'), 'Runner credential update is empty');
      check(Object.hasOwn(params, 'project_id') === Object.hasOwn(params, 'control_token'), 'Runner project identity and control credential are both required');
      for (const key of ['machine_token', 'control_token']) if (Object.hasOwn(params, key)) validateRunnerControlToken(params[key]);
    }
  }
  if (method === 'runner.project.set') {
    check(Number.isSafeInteger(params.expected_revision) && params.expected_revision >= 0, 'Runner policy revision required');
    check(Array.isArray(params.allowed_node_ids) && params.allowed_node_ids.length <= 64
      && params.allowed_node_ids.every(uuid) && new Set(params.allowed_node_ids).size === params.allowed_node_ids.length, 'invalid Runner project authorization');
    check(params.default_node_id === 'local' || uuid(params.default_node_id), 'invalid default Runner node');
  }
  return params;
}

/** No events/logging of parameters and no arbitrary service-method dispatch. */
export async function runnerManagement(service, method, params = {}) {
  validateRunnerParams(method, params);
  const { expected_revision, ...value } = params;
  try {
    switch (method) {
      case 'runner.deployments.get': return service.readDeployments();
      case 'runner.deployments.plan': return await service.planDeployment(params);
      case 'runner.deployments.apply': return await service.applyDeployment(params);
      case 'runner.deployments.confirm': return await service.confirmDeployment(params);
      case 'runner.deployments.reconcile': return await service.reconcileDeployment(params);
      case 'runner.deployments.recovery.plan': return await service.planDeploymentRecovery(params);
      case 'runner.deployments.recovery.apply': return await service.applyDeploymentRecovery(params);
      case 'runner.deployments.recovery.reconcile': return await service.reconcileDeploymentRecovery(params);
      case 'runner.ssh.discover': return service.discoverSsh();
      case 'runner.ssh.test': return await service.testSsh(value.ssh_alias);
      case 'runner.nodes.get': return service.readNodes();
      case 'runner.nodes.set': return await service.saveNodes(value, expected_revision);
      case 'runner.nodes.check': return await service.checkNode(value.node_id, value.project_id);
      case 'runner.credentials.get': return service.readCredentials();
      case 'runner.credentials.set': return await service.saveCredentials(value, expected_revision);
      case 'runner.credentials.remove': return await service.removeCredentials(value, expected_revision);
      case 'runner.project.get': return service.readPolicy();
      case 'runner.project.set': return await service.savePolicy(value, expected_revision);
    }
  } catch (error) {
    // Unexpected transport/storage exceptions must not put raw authentication or private JSON in daemon logs.
    throw new LushError(error instanceof LushError ? error.message : method.startsWith('runner.deployments.')
      ? 'Deployment operation not confirmed; inspect the original receipt, do not retry' : 'Runner operation not confirmed; inspect configuration and node state before retrying');
  }
}
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value ?? {}, key)).map(key => [key, value[key]]));
const nodeKeys = ['id', 'name', 'ssh_alias', 'expected_runner_id', 'enabled'];
const policyKeys = ['version', 'project_id', 'revision', 'authorization_version', 'allowed_node_ids', 'default_node_id'];
export function publicRunnerResult(value, method) {
  if (method.startsWith('runner.deployments.')) return publicDeployments(value);
  if (method === 'runner.ssh.discover') return { aliases: (value.aliases ?? []).filter(safeSshAlias).slice(0, 256),
    status: ['ok', 'missing', 'unavailable'].includes(value.status) ? value.status : 'unavailable', limited: value.limited === true };
  if (method === 'runner.ssh.test') return { ok: value.ok === true,
    reason: ['connected', 'not_confirmed', 'timeout', 'output_limit', 'config_unavailable', 'config_unsupported'].includes(value.reason) ? value.reason : 'not_confirmed',
    ...pick(value, ['checked_at']) };
  if (method === 'runner.worker.reconcile') return pick(value, ['worker_id', 'node_id', 'runner_id', 'generation', 'revision', 'state', 'reconciled', 'blocked_reason', 'checked', 'pending']);
  if (method.startsWith('runner.credentials.')) return { ...pick(value, ['version', 'revision']), nodes: (value.nodes ?? []).map(node => ({
    ...pick(node, ['node_id', 'machine_configured']), projects: (node.projects ?? []).map(project => pick(project, ['project_id', 'control_configured'])),
  })) };
  if (method === 'runner.nodes.get' || method === 'runner.nodes.set') return { ...pick(value, ['version', 'revision']), nodes: (value.nodes ?? []).map(node => ({
    ...pick(node, nodeKeys), budgets: pick(node.budgets, ['max_commands', 'timeout_ms', 'output_bytes']),
  })) };
  if (method === 'runner.project.get') return pick(value, policyKeys);
  if (method === 'runner.project.set') return { policy: pick(value.policy, policyKeys), stop_bindings: (value.stop_bindings ?? []).map(binding => pick(binding,
    ['project_id', 'node_id', 'runner_id', 'worker_id', 'workspace_id', 'generation', 'base_commit', 'head_commit', 'state', 'revision'])) };
  if (method === 'runner.nodes.check') return { ...pick(value, ['node_id', 'runner_id', 'checked_at', 'protocol_version', 'implementation_version', 'platform', 'arch', 'max_commands', 'memory_reserve_bytes', 'pinned']),
    capabilities: (value.capabilities ?? []).filter(name => CAPABILITIES.includes(name)), limits: pick(value.limits, Object.keys(LIMITS)) };
  return value;
}
