import { test, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DEPLOYMENT_ACTIONS, publicDeployment, publicDeployments, validateDeploymentRequest, validateDeploymentApproval } from '../src/core/runner-deployment-view.js';

const id = randomUUID();
test('deployment public projection is nested-whitelisted and never includes private evidence or scripts', () => {
  const privateValue = 'PRIVATE-TEST-FIXTURE';
  const hidden = { private_data: privateValue, token: privateValue, raw_stderr: privateValue, script: privateValue };
  const row = { id, revision: 3, status: 'planned', ssh_alias: 'safe', name: 'node', project_id: 'project-a', created_at: '2026-01-01T00:00:00Z', ...hidden,
    plan: { ...hidden, supported: true, install_root: '/home/user/.local/share/lush-runner/managed/' + id,
      target: { os: 'linux', arch: 'x64', uid: 1000, home: '/home/user', user: 'user', ...hidden },
      runtime: { version: '1.4.2', source: 'central-bun', sha256: 'a'.repeat(64), size: 10, file: privateValue, abi: { files: privateValue }, ...hidden },
      runner: { version: '1', sha256: 'b'.repeat(64), size: 20, file: privateValue, ...hidden }, files: ['bin/lush-runner', 'src/runner/index.js', hidden],
      actions: [{ id: 'cgroup_setup', label: 'Prepare dedicated unit', privileged: true, ...hidden }],
      blockers: [{ code: 'test', message: 'Fixed safe diagnostic', ...hidden }],
      dependencies: [{ name: 'Git', status: 'ready', version: '2.43.0', ...hidden }, { name: 'Bun', status: 'missing', ...hidden }],
      cgroup: { status: 'needs_setup', unit_path: '/etc/systemd/system/lush-runner-test.service', unit_sha256: 'c'.repeat(64), effect: 'enable and start', ...hidden },
      remote: hidden,
    }, stages: [{ id: 'validate_target', status: 'complete', message: 'Target checked', proof: hidden, ...hidden }] };
  const view = publicDeployment(row);
  expect(JSON.stringify(view)).not.toContain(privateValue);
  expect(view.plan.dependencies).toEqual([{ name: 'Git', status: 'ready', version: '2.43.0' }, { name: 'Bun', status: 'missing' }]);
  expect(view.plan.cgroup.unit_sha256).toBe('c'.repeat(64));
  expect(view.plan.files).toEqual(['bin/lush-runner', 'src/runner/index.js']);
  expect(view.stages).toEqual([{ id: 'validate_target', status: 'complete', message: 'Target checked' }]);
  expect(row.plan.runtime.file).toBe(privateValue);
  expect(publicDeployments({ items: [row], private_data: hidden })).toEqual({ version: 1, items: [view], truncated: false });
  expect(publicDeployments(row)).toEqual(view);
});

test('original inspection projection exposes bounded observation facts, not original IDs/private fingerprints/installer invocations or newly observed descriptors', () => {
  const secret = 'INSPECTION-PRIVATE', row = { id, status: 'unknown', plan: {}, stages: [], private_data: { reconciliations: [{ id: 'old', status: 'unknown', facts: { private_data: secret } },
    { id, status: 'complete', request_id: secret, original_operation_id: secret, created_at: '2026-01-01T00:00:00Z', facts: { local: { registration: 'matching', pairing: secret, token: secret }, remote: {
      integrity: 'verified', sealed: true, binding: 'matching', managed: { fingerprint: secret }, stages: Array(20).fill({ stage: 'runtime', status: 'done', request_id: secret }),
      installer: { state: 'inactive', tree_stopped: true, success: false, barrier: 'manager-exit-type-cgroup', unit: secret, invocation_id: secret, script: secret }, system: { load_state: 'loaded', active: false, unit: secret }, raw_stderr: secret } } }] } };
  const view = publicDeployment(row); expect(view.status).toBe('unknown'); expect(view.observation.status).toBe('complete');
  expect(view.observation.local).toEqual({ registration: 'matching', pairing: 'unknown' }); expect(view.observation.remote.stages).toHaveLength(7);
  expect(view.observation.remote.installer).toEqual({ state: 'inactive', tree_stopped: true, success: false, barrier: 'manager-exit-type-cgroup' });
  expect(view.observation.remote.system).toEqual({ load_state: 'loaded', active: false }); expect(JSON.stringify(view)).not.toContain(secret);
  expect(publicDeployments({ items: [row] }).items[0].observation).toEqual(view.observation);
  expect(publicDeployment(view)).toEqual(view); // Handler -> shared RPC -> Host re-projection preserves only the same sanitized observation.
  row.private_data.reconciliations[1].facts = { local: null, remote: null }; expect(() => publicDeployment(row)).not.toThrow();
});

test('deployment projection bounds list and nested collections and marks truncation', () => {
  const row = { plan: { files: Array(600).fill('file'), actions: Array(40).fill({}), dependencies: Array(40).fill({}), blockers: Array(40).fill({}) }, stages: Array(40).fill({}) };
  const result = publicDeployments({ items: Array(100).fill(row) });
  expect(result.items).toHaveLength(64); expect(result.truncated).toBe(true);
  expect(result.items[0].plan.files).toHaveLength(512); expect(result.items[0].plan.actions).toHaveLength(16);
  expect(result.items[0].plan.dependencies).toHaveLength(16); expect(result.items[0].plan.blockers).toHaveLength(32);
  expect(result.items[0].stages).toHaveLength(32);
  expect(publicDeployments({ items: [], truncated: true }).truncated).toBe(true);
});

test('deployment request contract requires exact confirmation, revision and fixed action approvals', () => {
  const apply = { id, expected_revision: 1, confirm: true, approved_actions: [...DEPLOYMENT_ACTIONS] };
  expect(() => validateDeploymentRequest('runner.deployments.apply', apply)).not.toThrow();
  for (const mutation of [{ id: 'wrong' }, { expected_revision: 0 }, { expected_revision: 1.1 }, { confirm: false }, { confirm: 'true' },
    { approved_actions: ['arbitrary_command'] }, { approved_actions: ['git_install', 'git_install'] }, { approved_actions: null }]) {
    expect(() => validateDeploymentRequest('runner.deployments.apply', { ...apply, ...mutation })).toThrow();
  }
  expect(() => validateDeploymentRequest('runner.deployments.confirm', { id, expected_revision: 1, confirm: true, runner_id: 'runner-1' })).not.toThrow();
  expect(() => validateDeploymentRequest('runner.deployments.confirm', { id, expected_revision: 1, confirm: true, runner_id: '' })).toThrow();
  expect(() => validateDeploymentRequest('runner.deployments.reconcile', { id, expected_revision: 1 })).not.toThrow();
  expect(() => validateDeploymentRequest('runner.deployments.unknown', apply)).toThrow();
});

test('deployment plan validation accepts only explicit bounded alias, name and project identity', () => {
  const plan = { ssh_alias: 'trusted-host', name: 'Runner node', project_id: 'project-a' };
  expect(() => validateDeploymentRequest('runner.deployments.plan', plan)).not.toThrow();
  for (const mutation of [{ ssh_alias: 'user@host' }, { ssh_alias: '-option' }, { ssh_alias: 'host;script' }, { ssh_alias: '' },
    { name: '' }, { name: ' padded ' }, { name: 'x\n' }, { name: 'x'.repeat(81) }, { project_id: '../escape' }, { project_id: '' }]) {
    expect(() => validateDeploymentRequest('runner.deployments.plan', { ...plan, ...mutation })).toThrow();
  }
});

const unitAction = id => ({ id, label: id, privileged: true, unit_path: `/etc/systemd/system/lush-runner-${id}-${id === 'git_install' ? 'installer' : 'delegate'}.service`,
  unit_sha256: 'a'.repeat(64), unit_summary: 'Fixed system binary and fixed unit identity', effect: 'Start the exact planned resource',
  ...(id === 'git_install' ? { packages: [{ name: 'git', version: '1:2.43.0-1ubuntu7.3', operation: 'install' },
    { name: 'libpcre2-8-0:amd64', version: '10.42-1ubuntu2', operation: 'install', previous_version: null }] } : {}) });
const approvalPlan = () => ({ supported: true, blockers: [], files: ['bin/bun', 'bin/lush-runner', 'config.json'],
  actions: DEPLOYMENT_ACTIONS.map(id => ['git_install', 'cgroup_setup'].includes(id) ? unitAction(id) : { id, label: id, privileged: false }) });

test('public system preparation preview lists exact unit digest/consequence and bounded dependency changes without raw scripts or repositories', () => {
  const secret = 'PRIVATE-APT-REPOSITORY-AND-SCRIPT', action = unitAction('git_install');
  action.repository = secret; action.argv = secret; action.unit_contents = secret;
  action.packages[0].repository_url = secret; action.packages[0].script = secret;
  const record = { plan: { actions: [action], system_setup: { unit_contents: secret } } };
  const result = publicDeployment(record).plan.actions[0];
  expect(result.unit_path).toBe(action.unit_path); expect(result.unit_sha256).toBe(action.unit_sha256);
  expect(result.unit_summary).toBe(action.unit_summary); expect(result.effect).toBe(action.effect);
  expect(result.packages).toEqual([{ name: 'git', version: '1:2.43.0-1ubuntu7.3', operation: 'install' },
    { name: 'libpcre2-8-0:amd64', version: '10.42-1ubuntu2', previous_version: null, operation: 'install' }]);
  expect(result.packages_truncated).toBe(false); expect(JSON.stringify(publicDeployment(record))).not.toContain(secret);
  record.plan.actions[0].packages = Array(129).fill(action.packages[0]);
  const bounded = publicDeployment(record).plan.actions[0]; expect(bounded.packages).toHaveLength(128); expect(bounded.packages_truncated).toBe(true);
});

test('approval is complete and per-action; blocked, missing steps, suppressed privilege, omitted files or unknown extra actions never authorize execution', () => {
  const initial = approvalPlan(), original = structuredClone(initial), approvals = initial.actions.map(action => action.id);
  expect(() => validateDeploymentApproval(initial, approvals)).not.toThrow(); expect(initial).toEqual(original);
  for (const change of [plan => { plan.supported = false; }, plan => { plan.blockers.push({ code: 'unknown' }); },
    plan => { plan.actions = plan.actions.filter(action => action.id !== 'verify_runner'); },
    plan => { plan.actions.find(action => action.id === 'git_install').privileged = false; },
    plan => { plan.actions.push({ id: 'arbitrary_root_action', privileged: true }); },
    plan => { plan.files = []; }, plan => { plan.files.push(plan.files[0]); }, plan => { plan.files = Array(513).fill('file'); }]) {
    const plan = approvalPlan(); change(plan); expect(() => validateDeploymentApproval(plan, plan.actions.map(action => action.id))).toThrow();
  }
  expect(() => validateDeploymentApproval(initial, approvals.filter(id => id !== 'git_install'))).toThrow('explicitly');
  expect(() => validateDeploymentApproval(initial, [...approvals, 'arbitrary_root_action'])).toThrow('explicitly');
  expect(() => validateDeploymentApproval(initial, [...approvals.slice(1), approvals[1]])).toThrow('explicitly');
  const withoutSystem = approvalPlan(); withoutSystem.actions = withoutSystem.actions.filter(action => !action.privileged);
  expect(() => validateDeploymentApproval(withoutSystem, withoutSystem.actions.map(action => action.id))).not.toThrow();
});

test('sudo approvals require exact distinct unit previews and a complete install-only Git dependency transaction', () => {
  for (const change of [action => { delete action.unit_path; }, action => { action.unit_path = '/etc/other.service'; },
    action => { delete action.unit_sha256; }, action => { delete action.unit_summary; }, action => { delete action.effect; },
    action => { action.packages_truncated = true; }, action => { action.packages = []; }, action => { action.packages = Array(129).fill(action.packages[0]); },
    action => { action.packages[1].operation = 'upgrade'; action.packages[1].previous_version = 'old'; },
    action => { action.packages[1].previous_version = 'old'; }, action => { action.packages[1].version = 'package; command'; },
    action => { action.packages[1].name = '../path'; }, action => { action.packages.push(action.packages[0]); },
    action => { action.packages = action.packages.filter(pkg => pkg.name !== 'git'); }]) {
    const plan = approvalPlan(); change(plan.actions.find(action => action.id === 'git_install'));
    expect(() => validateDeploymentApproval(plan, plan.actions.map(action => action.id))).toThrow();
  }
  const duplicate = approvalPlan(); duplicate.actions.find(action => action.id === 'cgroup_setup').unit_path = duplicate.actions.find(action => action.id === 'git_install').unit_path;
  expect(() => validateDeploymentApproval(duplicate, duplicate.actions.map(action => action.id))).toThrow('distinct');
});
