import { check } from './types.js';
import { publicRecoveryState } from './runner-deployment-recovery-view.js';
import { safeSshAlias } from './runner-ssh.js';

// Pure shared contract: imported by the Node-hosted RPC registry as well as Bun services.
// Never include private target proofs, authentication/config hashes, scripts, argv or transport output.
const ACTION_PRIVILEGES = Object.freeze({ node_register: false, credentials_pair: false, git_install: true, cgroup_setup: true,
  install_runtime: false, install_runner: false, configure_runner: false, verify_runner: false });
export const DEPLOYMENT_ACTIONS = Object.freeze(Object.keys(ACTION_PRIVILEGES));
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
export function validateDeploymentRequest(method, params) {
  if (method === 'runner.deployments.get') return;
  if (method === 'runner.deployments.plan') {
    check(safeSshAlias(params.ssh_alias), 'Invalid deployment SSH alias');
    check(typeof params.name === 'string' && params.name.trim() === params.name && params.name.length > 0 && params.name.length <= 80 && !/[\x00-\x1f\x7f]/.test(params.name), 'Invalid deployment name');
    check(typeof params.project_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(params.project_id), 'Invalid deployment project');
    return;
  }
  check(['runner.deployments.apply', 'runner.deployments.confirm', 'runner.deployments.reconcile'].includes(method), 'Invalid deployment operation');
  check(uuid(params.id) && Number.isSafeInteger(params.expected_revision) && params.expected_revision > 0, 'Deployment identity and revision are required');
  if (method !== 'runner.deployments.reconcile') check(params.confirm === true, 'Explicit deployment confirmation is required');
  if (method === 'runner.deployments.apply') check(Array.isArray(params.approved_actions) && params.approved_actions.length <= DEPLOYMENT_ACTIONS.length
    && params.approved_actions.every(value => DEPLOYMENT_ACTIONS.includes(value)) && new Set(params.approved_actions).size === params.approved_actions.length, 'Invalid deployment action approval');
  if (method === 'runner.deployments.confirm') check(typeof params.runner_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(params.runner_id), 'Invalid deployment installation identity');
}
// Admission of explicit approval only; target/SSH/ABI/artifact proof and CAS remain service duties.
export function validateDeploymentApproval(plan, approved_actions) {
  check(plan?.supported === true && Array.isArray(plan.blockers) && plan.blockers.length === 0, 'Deployment plan is blocked');
  check(Array.isArray(plan.actions) && plan.actions.length <= DEPLOYMENT_ACTIONS.length
    && plan.actions.every(action => DEPLOYMENT_ACTIONS.includes(action?.id) && action.privileged === ACTION_PRIVILEGES[action.id])
    && new Set(plan.actions.map(action => action.id)).size === plan.actions.length
    && DEPLOYMENT_ACTIONS.filter(id => !ACTION_PRIVILEGES[id]).every(id => plan.actions.some(action => action.id === id)), 'Deployment plan has incomplete or invalid actions');
  check(Array.isArray(approved_actions) && new Set(approved_actions).size === approved_actions.length && approved_actions.length === plan.actions.length
    && plan.actions.every(action => approved_actions.includes(action.id)), 'Every planned deployment action must be explicitly approved');
  check(Array.isArray(plan.files) && plan.files.length > 0 && plan.files.length <= 512 && new Set(plan.files).size === plan.files.length
    && plan.files.every(file => typeof file === 'string' && file.length > 0 && file.length <= 1024 && !/[\x00-\x1f\x7f]/.test(file)), 'Deployment file preview is incomplete');
  const units = [];
  for (const action of plan.actions.filter(action => action.privileged)) {
    check(typeof action.unit_path === 'string' && /^\/etc\/systemd\/system\/[A-Za-z0-9][A-Za-z0-9_.-]{0,191}\.service$/.test(action.unit_path)
      && typeof action.unit_sha256 === 'string' && /^[a-f0-9]{64}$/.test(action.unit_sha256)
      && typeof action.unit_summary === 'string' && action.unit_summary.length > 0 && action.unit_summary.length <= 1024
      && typeof action.effect === 'string' && action.effect.length > 0 && action.effect.length <= 512, 'Deployment system preparation preview is incomplete');
    units.push(action.unit_path);
    if (action.id === 'git_install') check(Array.isArray(action.packages) && action.packages.length > 0 && action.packages.length <= 128 && action.packages_truncated !== true
      && action.packages.every(pkg => typeof pkg?.name === 'string' && /^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9-]+)?$/.test(pkg.name) && pkg.name.length <= 128
        && typeof pkg.version === 'string' && /^[A-Za-z0-9][A-Za-z0-9.+:~_-]{0,127}$/.test(pkg.version)
        && pkg.operation === 'install' && (pkg.previous_version === undefined || pkg.previous_version === null))
      && new Set(action.packages.map(pkg => pkg.name)).size === action.packages.length
      && action.packages.some(pkg => pkg.name === 'git' || pkg.name.startsWith('git:')), 'Git dependency transaction is incomplete or would change an existing package');
  }
  check(new Set(units).size === units.length, 'Deployment system preparation units must be distinct');
}
const pick = (value, names) => Object.fromEntries(names.filter(name => Object.hasOwn(value ?? {}, name)).map(name => [name, value[name]]));
const scalar = value => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null;
const projection = (value, names) => Object.fromEntries(Object.entries(pick(value, names)).filter(([, item]) => scalar(item)));
function actionProjection(value) {
  const result = projection(value, ['id', 'label', 'privileged', 'unit_path', 'unit_sha256', 'unit_summary', 'effect']);
  if (Object.hasOwn(value ?? {}, 'packages')) {
    result.packages = (Array.isArray(value.packages) ? value.packages : []).slice(0, 128)
      .map(value => projection(value, ['name', 'version', 'previous_version', 'operation']));
    result.packages_truncated = value.packages_truncated === true || Array.isArray(value.packages) && value.packages.length > 128;
  }
  return result;
}
// One projection for stored and returned observation facts; never persist a newly observed managed
// descriptor as authority, nor leak remote request IDs, private proofs, unit bodies or diagnostics.
export function deploymentObservationFacts({ local = {}, remote = {} } = {}) {
  local ??= {}; remote ??= {};
  const one = (value, allowed) => allowed.includes(value) ? value : 'unknown';
  const booleans = (value, names) => Object.fromEntries(names.filter(key => typeof value?.[key] === 'boolean').map(key => [key, value[key]]));
  const result = { local: Object.fromEntries(['registration', 'pairing'].map(key => [key, one(local[key], ['unrecorded', 'missing', 'matching', 'changed'])])),
    remote: { integrity: one(remote.integrity, ['not_started', 'not_configured', 'verified', 'changed']), ...booleans(remote, ['sealed']),
      binding: one(remote.binding, ['unrecorded', 'matching', 'changed']),
      stages: (Array.isArray(remote.stages) ? remote.stages : []).filter(value => ['prepare', 'runtime', 'runner', 'git_install', 'cgroup_setup', 'configure', 'seal'].includes(value?.stage)).slice(0, 7)
        .map(value => ({ stage: value.stage, status: one(value.status, ['not_started', 'done', 'failed']) })) } };
  if (remote.installer) result.remote.installer = { state: one(remote.installer.state, ['not-found', 'active', 'inactive', 'failed', 'activating', 'deactivating']),
    ...booleans(remote.installer, ['tree_stopped', 'success']), barrier: one(remote.installer.barrier, ['systemctl-wait-exit-type-cgroup', 'manager-exit-type-cgroup']) };
  if (remote.system) result.remote.system = { load_state: one(remote.system.load_state, ['loaded', 'not-found', 'error']), ...booleans(remote.system, ['active']) };
  return result;
}
export function publicDeployment(record) {
  const plan = record.plan ?? {}, observation = Array.isArray(record.private_data?.reconciliations) ? record.private_data.reconciliations.at(-1) : record.observation;
  return { ...publicRecoveryState(record), ...(observation ? { observation: { ...projection(observation, ['id', 'status', 'created_at', 'completed_at']),
      ...deploymentObservationFacts(observation.facts ?? observation) } } : {}), ...projection(record, ['id', 'revision', 'status', 'ssh_alias', 'name', 'project_id', 'node_id', 'runner_id', 'created_at', 'updated_at']),
    plan: {
      target: projection(plan.target, ['os', 'arch', 'user', 'uid', 'home']),
      ...projection(plan, ['install_root', 'supported']),
      ...(plan.node_budgets ? { node_budgets: projection(plan.node_budgets, ['max_commands', 'timeout_ms', 'output_bytes']) } : {}),
      runtime: projection(plan.runtime, ['version', 'source', 'sha256', 'size']),
      runner: projection(plan.runner, ['version', 'sha256', 'size']),
      files: (Array.isArray(plan.files) ? plan.files : []).filter(value => typeof value === 'string').slice(0, 512),
      actions: (Array.isArray(plan.actions) ? plan.actions : []).slice(0, 16).map(actionProjection),
      blockers: (Array.isArray(plan.blockers) ? plan.blockers : []).map(value => projection(value, ['code', 'message'])).slice(0, 32),
      dependencies: (Array.isArray(plan.dependencies) ? plan.dependencies : []).map(value => projection(value, ['name', 'status', 'version', 'message'])).slice(0, 16),
      cgroup: projection(plan.cgroup, ['status', 'path', 'message', 'unit', 'unit_path', 'unit_sha256', 'relative_group', 'binding', 'effect', 'unit_summary']),
    }, stages: (Array.isArray(record.stages) ? record.stages : []).map(value => projection(value, ['id', 'status', 'message'])).slice(0, 32),
  };
}
export function publicDeployments(value) {
  if (Array.isArray(value.items)) return { version: 1, items: value.items.slice(0, 64).map(publicDeployment), truncated: value.truncated === true || value.items.length > 64 };
  return publicDeployment(value);
}
