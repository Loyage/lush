import { DeploymentPlans } from '../src/core/runner-deployment-plans.js';
import { buildDeploymentArtifacts } from '../src/core/runner-deployment-bundle.js';
import { managementFixture } from './runner-management-fixture.js';
import { remoteFixture } from './runner-deployment-remote-fixture.js';

export const deploymentId = '11111111-1111-4111-8111-111111111111';
export const recoveryId = '22222222-2222-4222-8222-222222222222';
export const deploymentRequests = Object.freeze({
  'runner.deployments.plan': { ssh_alias: 'fixture', name: 'Deployment API fixture', project_id: 'deployment-api' },
  'runner.deployments.apply': { id: deploymentId, expected_revision: 1, approved_actions: [], confirm: true },
  'runner.deployments.confirm': { id: deploymentId, expected_revision: 1, runner_id: deploymentId, confirm: true },
  'runner.deployments.reconcile': { id: deploymentId, expected_revision: 1 },
  'runner.deployments.recovery.plan': { id: deploymentId, expected_revision: 1 },
  'runner.deployments.recovery.apply': { id: deploymentId, expected_revision: 1, recovery_id: recoveryId, approved_actions: ['bind_runtime_generation'], confirm: true },
  'runner.deployments.recovery.reconcile': { id: deploymentId, expected_revision: 1, recovery_id: recoveryId },
});

// Real current-runtime production bundle and controlled SSH subprocess; never executes the host's
// SSH/sudo/systemctl or creates a real cgroup. ABI or dedicated-cgroup evidence is intentionally
// unsupported, so the actual service must return blocked and cannot prepare/upload/install/pair.
// This is a genuine user-entry fail-closed chain, not positive production cgroup acceptance.
export async function deploymentApiFixture() {
  const f = await managementFixture(), remote = remoteFixture();
  let builds = 0, cleanups = 0, snapshot = { status: 'ok', limited: false, configuration: 'Host fixture\nhostname "fixture.invalid"\n' };
  const plans = new DeploymentPlans(f.config, { snapshot: () => snapshot, build_artifacts: async () => {
    builds++; const value = await buildDeploymentArtifacts(), cleanup = value.cleanup;
    return { ...value, cleanup() { cleanups++; return cleanup(); } };
  }, remote_factory: options => remote.remote({ ...options, timeout_ms: 2000 }) });
  f.runnerOptions.deployment = { plans };
  return { ...f, remote, plans, get builds() { return builds; }, get cleanups() { return cleanups; }, set snapshot(value) { snapshot = value; },
    async close() { await f.close(); await plans.close(); await remote.close(); } };
}
