import { randomBytes } from 'node:crypto';
import { RunnerSettings, normalizeRunnerNode } from './runner-settings.js';
import { RunnerCredentials } from './runner-credentials.js';
import { validateDeploymentApproval } from './runner-deployment-view.js';
import { hash, stable } from '../runner/protocol.js';
import { check } from './types.js';

function authorized(context, stage = null) {
  check(context && ['read', 'guard', 'checkpoint'].every(key => typeof context[key] === 'function'), 'Deployment journal context is required');
  check(!context.guard()?.then, 'Deployment local guard must be synchronous');
  const record = context.read(), data = record.private_data, approval = data?.approval;
  check(record.status === 'running' && typeof data?.operation_id === 'string' && approval?.confirm === true
    && approval.operation_id === data.operation_id && /^[a-f0-9]{64}$/.test(data.plan_sha256 ?? '')
    && approval.plan_sha256 === data.plan_sha256 && hash(stable(record.plan)) === data.plan_sha256,
  'Deployment requires approval of its exact frozen plan and operation');
  validateDeploymentApproval(record.plan, approval.approved_actions);
  const active = data.active_stage, intent = data.intents?.[active];
  check(typeof active === 'string' && (!stage || active === stage) && intent?.id === active
    && intent.operation_id === data.operation_id && intent.status === 'running', 'Deployment local stage has no original durable intent');
  return record;
}
function checkpoint(context, mutate) {
  check(!context.checkpoint(mutate)?.then, 'Deployment local receipt must be synchronous');
}
const sameNode = (current, expected) => current && expected && ['id', 'ssh_alias', 'enabled', 'expected_runner_id', 'budgets']
  .every(key => stable(current[key]) === stable(expected[key]));
const sameAuth = (a, b) => a && b && a.machine_token === b.machine_token && a.control_token === b.control_token;

/** Trusted central apply stages only, not a JSON API. The caller must retain the complete
 * journal/lease and perform remote validation. No SSH, project grant, pin or rollback here.
 */
export class DeploymentLocal {
  constructor(config, { settings = new RunnerSettings(config), credentials = new RunnerCredentials(config) } = {}) {
    this.settings = settings; this.credentials = credentials;
  }
  register(context) {
    const record = authorized(context, 'node_register');
    check(!record.private_data.local?.registration, 'Deployment registration cannot be replayed');
    const node = normalizeRunnerNode({ id: record.node_id ?? record.id, name: record.name, ssh_alias: record.ssh_alias,
      enabled: false, expected_runner_id: null, budgets: record.plan.node_budgets });
    const before = this.settings.read(), intent = record.private_data.intents.node_register;
    check(!before.nodes.some(item => item.id === node.id || item.ssh_alias === node.ssh_alias), 'Deployment cannot adopt an existing Runner node or SSH alias');
    checkpoint(context, row => {
      row.node_id = node.id; row.private_data.local ??= {};
      row.private_data.local.registration = { node, expected_revision: before.revision, operation_id: intent.operation_id,
        request_id: intent.request_id, status: 'intent' };
    });
    const { id, name, ssh_alias } = node;
    const saved = this.settings.registerDeployment({ id, name, ssh_alias, budgets: node.budgets }, before.revision, context.guard);
    check(sameNode(saved.nodes.find(item => item.id === id), node), 'Deployment registration acknowledgement changed');
    checkpoint(context, row => Object.assign(row.private_data.local.registration, { status: 'complete', saved_revision: saved.revision }));
    return { node_id: id };
  }
  pair(context) {
    const record = authorized(context, 'credentials_pair');
    this.assert(context, { paired: false });
    check(!record.private_data.local?.pairing, 'Deployment credential generation cannot be replayed');
    const before = this.credentials.read();
    check(!before.nodes.some(item => item.node_id === record.node_id), 'Deployment cannot overwrite existing Runner credentials');
    const auth = { machine_token: randomBytes(32).toString('base64url'), control_token: randomBytes(32).toString('base64url') };
    check(auth.machine_token !== auth.control_token, 'Independent deployment credentials were not generated');
    const intent = record.private_data.intents.credentials_pair;
    checkpoint(context, row => {
      row.private_data.local.pairing = { auth, node_id: row.node_id, project_id: row.project_id, expected_revision: before.revision,
        request_id: intent.request_id, operation_id: intent.operation_id, status: 'intent' };
    });
    this.credentials.pairDeployment({ node_id: record.node_id, project_id: record.project_id, ...auth }, before.revision, context.guard);
    const actual = this.credentials.snapshot(record.node_id, record.project_id);
    check(sameAuth(actual, auth), 'Deployment credential acknowledgement changed');
    checkpoint(context, row => { row.private_data.local.pairing.status = 'complete'; });
    return { node_id: record.node_id, project_id: record.project_id,
      machine_token_hash: hash(auth.machine_token), control_token_hash: hash(auth.control_token) };
  }
  assert(context, { paired = true } = {}) {
    const record = authorized(context), registration = record.private_data.local?.registration;
    check(registration?.status === 'complete' && registration.node?.id === record.node_id
      && registration.operation_id === record.private_data.operation_id
      && registration.request_id === record.private_data.intents.node_register?.request_id,
    'Deployment node registration evidence is incomplete');
    check(sameNode(this.settings.read().nodes.find(node => node.id === record.node_id), registration.node), 'Deployment node configuration changed');
    if (paired) {
      const pairing = record.private_data.local?.pairing;
      check(pairing?.status === 'complete' && pairing.node_id === record.node_id && pairing.project_id === record.project_id
        && pairing.operation_id === record.private_data.operation_id
        && pairing.request_id === record.private_data.intents.credentials_pair?.request_id,
      'Deployment pairing evidence is incomplete');
      check(sameAuth(this.credentials.snapshot(record.node_id, record.project_id), pairing.auth), 'Deployment control credentials changed');
    }
    check(!context.guard()?.then, 'Deployment local guard must be synchronous');
  }
  /** Only a trusted verifier obtains plaintext, after latest central configuration checks. */
  auth(context) {
    this.assert(context);
    const record = context.read();
    // Return the approved pairing just checked, never a second unvalidated read after a rotation.
    return structuredClone(record.private_data.local.pairing.auth);
  }
  /** Explicit original-evidence observation only. Does not recover/advance a receipt or replay a write. */
  observe(record) {
    const registration = record.private_data.local?.registration, pairing = record.private_data.local?.pairing;
    const node = registration ? this.settings.read().nodes.find(item => item.id === record.node_id) : null;
    const confirmed = record.status === 'confirmed' && record.private_data.confirmation?.status === 'complete';
    const expected = confirmed && node ? { ...registration?.node, expected_runner_id: record.runner_id, enabled: node.enabled, budgets: node.budgets } : registration?.node;
    const result = { registration: !registration ? 'unrecorded' : !node ? 'missing' : sameNode(node, expected) ? 'matching' : 'changed', pairing: 'unrecorded' };
    if (pairing) {
      const node = this.credentials.read().nodes.find(item => item.node_id === record.node_id);
      result.pairing = !node ? 'missing' : node.machine_configured && node.projects.some(item => item.project_id === record.project_id)
        && pairing.node_id === record.node_id && pairing.project_id === record.project_id
        && sameAuth(this.credentials.snapshot(record.node_id, record.project_id), pairing.auth) ? 'matching' : 'changed';
    }
    return result;
  }
}
