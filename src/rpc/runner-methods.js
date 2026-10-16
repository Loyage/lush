import { check, isPlainObject, LushError } from '../core/types.js';
import { LIMITS, CAPABILITIES } from '../runner/protocol.js';
import { normalizeRunnerNode } from '../core/runner-settings.js';
import { validateRunnerControlToken } from '../core/runner-credentials.js';

// Single registration source for RPC, CLI, HTTP allowlists and Host device-only operations.
export const RUNNER_METHODS = Object.freeze({
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
    throw new LushError(error instanceof LushError ? error.message : 'Runner operation not confirmed; inspect configuration and node state before retrying');
  }
}
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value ?? {}, key)).map(key => [key, value[key]]));
const nodeKeys = ['id', 'name', 'ssh_alias', 'expected_runner_id', 'enabled'];
const policyKeys = ['version', 'project_id', 'revision', 'authorization_version', 'allowed_node_ids', 'default_node_id'];
export function publicRunnerResult(value, method) {
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
