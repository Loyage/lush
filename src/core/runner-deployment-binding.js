import { validateManagedDescription } from './runner-deployment-remote-launch.js';
import { validateDeploymentApproval } from './runner-deployment-view.js';
import { hash, stable } from '../runner/protocol.js';
import { check } from './types.js';

/** Current central safety evidence for the original installation. Never grants project authority,
 * connects, adopts a different descriptor or repairs state. No plaintext is returned to public APIs.
 */
export function assertDeploymentBinding(record, { settings, credentials }, { confirmed = false, observation = false } = {}) {
  const data = record.private_data, registration = data?.local?.registration, pairing = data?.local?.pairing, proof = data?.proof;
  check(record.node_id && record.runner_id && data.plan_sha256 === hash(stable(record.plan)), 'Deployment installation evidence is incomplete');
  validateDeploymentApproval(record.plan, data.approval?.approved_actions);
  check(registration?.status === 'complete' && pairing?.status === 'complete' && registration.node?.id === record.node_id
    && pairing.node_id === record.node_id && pairing.project_id === record.project_id
    && registration.operation_id === pairing.operation_id && data.approval?.operation_id === registration.operation_id
    && data.approval.confirm === true && data.approval.plan_sha256 === data.plan_sha256
    && data.intents?.node_register?.request_id === registration.request_id && data.intents?.credentials_pair?.request_id === pairing.request_id,
  'Deployment original registration or pairing evidence changed');
  check(proof?.operation_id === registration.operation_id && proof.node_id === record.node_id && proof.project_id === record.project_id
    && proof.runner_id === record.runner_id && proof.runtime_version === record.plan.runtime.version
    && proof.implementation_version === record.plan.runner.version && proof.platform === record.plan.target.os && proof.arch === record.plan.target.arch
    && proof.runtime_verified === true && proof.ffi_verified === true
    && proof.stop_confirmed === true && proof.barrier_confirmed === true && data.seal?.runner_id === record.runner_id,
  'Deployment original verification and seal are incomplete');
  const managed = validateManagedDescription(data.managed);
  check(managed.deployment_id === record.id && managed.node_id === record.node_id && managed.plan_sha256 === data.plan_sha256
    && managed.ssh_alias === record.ssh_alias && managed.ssh_config_sha256 === hash(data.ssh_configuration)
    && managed.runtime_sha256 === record.plan.runtime.sha256 && managed.runtime_size === record.plan.runtime.size && managed.runner_sha256 === record.plan.runner.sha256
    && stable(managed.target) === stable(record.plan.target) && stable(managed.remote) === stable(record.plan.remote)
    && stable(managed.abi) === stable(record.plan.abi), 'Deployment managed binding changed');
  const cgroup = data.system_results?.cgroup_setup?.cgroup ?? record.plan.cgroup;
  check(managed.cgroup_root === cgroup?.path && stable(managed.cgroup_evidence) === stable(cgroup?.evidence), 'Deployment cgroup binding changed');
  const node = settings.read().nodes.find(node => node.id === record.node_id), expected = registration.node;
  // Deployment confirmation requires the original settings exactly. Later central policy edits
  // (disable/budgets) must retain diagnostics/fixed stop; ordinary Run admission/versioning remains
  // RunnerService's duty and the immutable remote config still caps every actual command.
  check(node && node.ssh_alias === expected.ssh_alias && ((confirmed && observation) || (stable(node.budgets) === stable(expected.budgets) && node.enabled === confirmed))
    && node.expected_runner_id === (confirmed ? record.runner_id : null), 'Deployment central node changed');
  const auth = credentials.snapshot(record.node_id, record.project_id);
  check(auth.machine_token === pairing.auth?.machine_token && auth.control_token === pairing.auth?.control_token, 'Deployment credentials changed');
  return { node, managed };
}
