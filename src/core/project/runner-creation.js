import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { check } from '../types.js';
import { runnerIdentity } from '../runner-service.js';
import { assertRemoteConfiguration } from '../../agent/remote-provider.js';
import { piConfigDirectory, readPiConfiguration } from '../../agent/pi-config.js';

/** Admission-only selection. Existing Workers never consult the new-order default. */
export function selectCreationRunner(project, requested, { parent = null, profile = null } = {}) {
  check(requested === undefined || typeof requested === 'string' && requested.length > 0, 'runner_node_id must be local or a registered node id');
  const selected = requested ?? (parent ? project.store.runnerBinding(parent.id)?.node_id ?? 'local'
    : project.store.runnerProject().default_node_id);
  if (selected === 'local') return null;
  const node = project.runners.selectNode(selected);
  const task = parent ?? { role: 'agent', task_kind: 'order' };
  const agent = profile ?? project.provider.resolve?.(task) ?? project.agentSettings.resolve('agent');
  assertRemoteConfiguration(agent, readPiConfiguration(path.join(piConfigDirectory(project.config), 'settings.json')));
  return node;
}

export function creationIdentity(project, node, worker_id) {
  return { project_id: project.store.runnerProject().project_id, node_id: node.id, runner_id: node.expected_runner_id,
    worker_id, workspace_id: randomUUID(), generation: 1 };
}

/** A local binding cannot be substituted after awaiting Git. */
export function guardCreationRunner(project, node) {
  if (!node) return;
  const current = project.runners.selectNode(node.id);
  check(current.expected_runner_id === node.expected_runner_id && current.ssh_alias === node.ssh_alias,
    'Runner installation changed during creation');
}

/** Freeze the actual committed parent tip before a new child/order takes a central baseline.
 * No network under the Git writer queue; neither uncommitted content nor checkpoint paths come
 * from the node. Current-Run capture is owned by its fixed invocation connection.
 */
export async function captureRunnerParent(project, parent) {
  const binding = project.store.runnerBinding(parent.id);
  if (!binding) return;
  const run = project.running.get(parent.id);
  if (run) {
    check(run.remote?.capture && !run.invocationEnded && !run.controller.signal.aborted,
      'Remote parent invocation is not ready to capture its committed baseline');
    await run.remote.capture();
    return;
  }
  check(binding.state === 'ready', 'Remote parent workspace is unavailable or unknown');
  const barriers = project.store.runnerBarriers(parent.id);
  check(!barriers.bindings.length && !barriers.runs.length && !barriers.receipts.length,
    'Remote parent still has an execution or synchronization barrier');
  const identity = runnerIdentity(binding, { operation_id: randomUUID() });
  const connection = await project.runners.connect(identity);
  const options = { client: connection.client, identity, authorization_version: project.store.runnerProject().authorization_version,
    request_id: randomUUID(), guard() {
      connection.assertCurrent();
      project.assertWritable('capture the remote parent'); project.runners.assertBinding(identity);
    } };
  try {
    const observed = await project.workspaces.inspectRemoteWorkspace({ ...options, require_no_lease: true });
    // Even an unchanged tip is inspected remotely; a stale central ref never impersonates live code.
    if (observed.head_commit !== binding.head_commit) await project.workspaces.receiveRemoteCommit({ ...options,
      commit: observed.head_commit, old_commit: binding.head_commit, original_commit: binding.base_commit });
  } finally { await connection.close(); }
}
