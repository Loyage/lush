import { test, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DeploymentLocal } from '../src/core/runner-deployment-local.js';
import { DeploymentStore } from '../src/core/runner-deployment-store.js';
import { DeploymentOperations } from '../src/core/runner-deployment-operations.js';
import { DEPLOYMENT_ACTIONS, publicDeployment } from '../src/core/runner-deployment-view.js';
import { hash, stable } from '../src/runner/protocol.js';

const budgets = { max_commands: 1, timeout_ms: 60000, output_bytes: 1048576 };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-test-deployment-local-')), config = { home: path.join(root, 'device') };
  const store = new DeploymentStore(config), operations = new DeploymentOperations(store), local = new DeploymentLocal(config);
  // Local-only synthetic approved plan, NOT a target probe, remote installation or Runner readiness.
  const plan = { supported: true, blockers: [], node_budgets: budgets, files: ['bin/bun', 'config.json'],
    actions: DEPLOYMENT_ACTIONS.filter(id => !['git_install', 'cgroup_setup'].includes(id)).map(id => ({ id, privileged: false })) };
  const row = store.create({ status: 'planned', ssh_alias: 'fixture', name: 'Local fixture', project_id: 'local-project',
    plan, stages: [], private_data: { plan_sha256: hash(stable(plan)) } });
  const f = { root, config, store, operations, local, row, auth: null, hashes: null,
    run({ approval = value => value, after_register = null, after_pair = null, local_context = value => value } = {}) {
      return operations.run(f.row.id, f.row.revision, { stages: ['node_register', 'credentials_pair', 'observe_local'], finish: 'planned' }, async context => {
        const localContext = local_context(context);
        if (approval) context.checkpoint(receipt => { receipt.private_data.approval = approval({ confirm: true,
          operation_id: receipt.private_data.operation_id, plan_sha256: receipt.private_data.plan_sha256,
          approved_actions: plan.actions.map(action => action.id) }); });
        await context.stage('node_register', () => local.register(localContext));
        await after_register?.(context);
        await context.stage('credentials_pair', () => { f.hashes = local.pair(localContext); return f.hashes; });
        await after_pair?.(context);
        await context.stage('observe_local', () => { f.auth = local.auth(localContext); });
      });
    },
    async close() { await operations.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
  return f;
}

function noPublicSecrets(record, auth) {
  const publicText = JSON.stringify(publicDeployment(record));
  for (const token of Object.values(auth)) { expect(publicText).not.toContain(token); expect(publicText).not.toContain(hash(token)); }
}

test('approved durable stages pre-record a fresh disabled node and independent credentials before actual central publication', async () => {
  const f = fixture(); let registrationSpy, pairingSpy;
  try {
    const register = f.local.settings.registerDeployment.bind(f.local.settings);
    registrationSpy = spyOn(f.local.settings, 'registerDeployment').mockImplementation((value, revision, guard) => {
      const record = f.store.read(f.row.id);
      expect(record.node_id).toBe(value.id); expect(value.id).toBe(f.row.id);
      expect(record.private_data.local.registration).toMatchObject({ status: 'intent', expected_revision: revision, node: { id: value.id, enabled: false, expected_runner_id: null } });
      expect(record.private_data.local.registration.request_id).toBe(record.private_data.intents.node_register.request_id);
      expect(f.store.isActive(record.id)).toBe(true);
      return register(value, revision, guard);
    });
    const pair = f.local.credentials.pairDeployment.bind(f.local.credentials);
    pairingSpy = spyOn(f.local.credentials, 'pairDeployment').mockImplementation((value, revision, guard) => {
      const record = f.store.read(f.row.id), intent = record.private_data.local.pairing;
      expect(intent).toMatchObject({ status: 'intent', expected_revision: revision, node_id: value.node_id, project_id: value.project_id });
      expect(intent.auth).toEqual({ machine_token: value.machine_token, control_token: value.control_token });
      expect(intent.request_id).toBe(record.private_data.intents.credentials_pair.request_id);
      return pair(value, revision, guard);
    });
    expect(() => f.local.settings.save({ nodes: [{ id: f.row.id, name: f.row.name, ssh_alias: 'fixture', enabled: false, budgets }] }, f.local.settings.read().revision)).toThrow('omit id');
    const result = await f.run();
    expect(result.status).toBe('planned'); expect(f.local.settings.read().nodes[0]).toMatchObject({ id: f.row.id, enabled: false, expected_runner_id: null, budgets });
    expect(f.auth.machine_token).not.toBe(f.auth.control_token);
    for (const token of Object.values(f.auth)) { expect(Buffer.from(token, 'base64url')).toHaveLength(32); expect(Buffer.from(token, 'base64url').toString('base64url')).toBe(token); }
    expect(f.hashes).toEqual({ node_id: f.row.id, project_id: 'local-project', machine_token_hash: hash(f.auth.machine_token), control_token_hash: hash(f.auth.control_token) });
    expect(f.hashes.machine_token_hash).not.toBe(hash(Buffer.from(f.auth.machine_token, 'base64url')));
    expect(f.local.credentials.snapshot(f.row.id, 'local-project')).toEqual(f.auth);
    expect(f.local.observe(result)).toEqual({ registration: 'matching', pairing: 'matching' });
    for (const file of ['runners.json', 'runner-credentials.json', 'runner-deployments.json']) expect(fs.statSync(path.join(f.config.home, file)).mode & 0o777).toBe(0o600);
    for (const token of Object.values(f.auth)) {
      expect(JSON.stringify(f.local.settings.read())).not.toContain(token); expect(JSON.stringify(f.local.credentials.read())).not.toContain(token);
    }
    noPublicSecrets(result, f.auth);
  } finally { registrationSpy?.mockRestore(); pairingSpy?.mockRestore(); await f.close(); }
});

test('missing, incomplete, wrong-plan or wrong-operation approvals cannot register a node or generate/pair credentials', async () => {
  for (const approval of [null, value => ({ ...value, confirm: false }), value => ({ ...value, approved_actions: ['credentials_pair'] }),
    value => ({ ...value, plan_sha256: '0'.repeat(64) }), value => ({ ...value, operation_id: randomUUID() })]) {
    const f = fixture();
    try {
      const result = await f.run({ approval });
      expect(result.status).toBe('unknown'); expect(result.node_id).toBeUndefined(); expect(result.private_data.local).toBeUndefined();
      expect(f.local.settings.read().nodes).toEqual([]); expect(f.local.credentials.read()).toEqual({ version: 1, revision: 'absent', nodes: [] });
    } finally { await f.close(); }
  }
});

test('existing aliases and retired IDs are never adopted; public replacement still cannot choose a fresh ID', async () => {
  for (const mode of ['alias', 'retired']) {
    const f = fixture();
    try {
      const before = f.local.settings.read();
      const saved = f.local.settings.save({ nodes: [{ name: 'Manual', ssh_alias: 'fixture', enabled: true, budgets }] }, before.revision);
      if (mode === 'retired') {
        f.local.settings.save({ nodes: [] }, saved.revision);
        f.row = f.store.change(f.row.id, f.row.revision, row => { row.node_id = saved.nodes[0].id; });
      }
      const settings = f.local.settings.read(), result = await f.run();
      expect(result.status).toBe('unknown'); expect(f.local.settings.read()).toEqual(settings); expect(f.local.credentials.read().nodes).toEqual([]);
    } finally { await f.close(); }
  }
});

for (const stage of ['registration', 'pairing']) test(`lost local ${stage} ACK preserves original evidence and partial state; observation never retries or advances receipt`, async () => {
  const f = fixture(); let spy, calls = 0;
  try {
    const service = stage === 'registration' ? f.local.settings : f.local.credentials, method = stage === 'registration' ? 'registerDeployment' : 'pairDeployment';
    const original = service[method].bind(service);
    spy = spyOn(service, method).mockImplementation((...args) => { calls++; original(...args); throw new Error('PRIVATE-ACK-MATERIAL'); });
    const result = await f.run();
    expect(result.status).toBe('unknown'); expect(calls).toBe(1);
    expect(f.local.settings.read().nodes[0]).toMatchObject({ id: result.node_id, enabled: false, expected_runner_id: null });
    expect(result.private_data.local[stage].status).toBe('intent');
    const disk = fs.readFileSync(path.join(f.config.home, 'runner-deployments.json'), 'utf8');
    expect(f.local.observe(result)).toEqual({ registration: 'matching', pairing: stage === 'pairing' ? 'matching' : 'unrecorded' });
    expect(fs.readFileSync(path.join(f.config.home, 'runner-deployments.json'), 'utf8')).toBe(disk); expect(calls).toBe(1);
    expect(() => f.operations.run(result.id, result.revision, { stages: ['node_register'] }, () => { calls++; })).toThrow('cannot be replayed');
    expect(calls).toBe(1);
    if (stage === 'pairing') noPublicSecrets(result, result.private_data.local.pairing.auth);
  } finally { spy?.mockRestore(); await f.close(); }
});

test('lost deployment lease before settings publication cannot publish a node, repair a lock or erase original intent', async () => {
  const f = fixture(); let spy;
  try {
    const original = f.local.settings.registerDeployment.bind(f.local.settings); let guards = 0;
    spy = spyOn(f.local.settings, 'registerDeployment').mockImplementation((value, revision, guard) => original(value, revision, () => {
      if (++guards === 3) {
        const lock = path.join(f.config.home, `.runner-deployment-${f.row.id}.lock`);
        fs.renameSync(lock, lock + '.original'); fs.writeFileSync(lock, '', { mode: 0o600 });
      }
      return guard();
    }));
    const result = await f.run();
    expect(result.status).toBe('unknown'); expect(f.local.settings.read().nodes).toEqual([]); expect(f.local.credentials.read().nodes).toEqual([]);
    expect(f.store.read(result.id).private_data.local.registration.status).toBe('intent');
    expect(f.operations.view(f.store.read(result.id)).status).toBe('unknown');
    expect(fs.readdirSync(f.config.home).some(name => name.endsWith('.tmp'))).toBe(false);
  } finally { spy?.mockRestore(); await f.close(); }
});

test('credential publication rechecks the lease guard; failure retains disabled registration and private generated intent, not a credential file', async () => {
  const f = fixture(); let spy;
  try {
    const original = f.local.credentials.pairDeployment.bind(f.local.credentials); let guards = 0;
    spy = spyOn(f.local.credentials, 'pairDeployment').mockImplementation((value, revision, guard) => original(value, revision, () => {
      if (++guards === 4) throw new Error('PRIVATE-REVOKED-GUARD');
      return guard();
    }));
    const result = await f.run();
    expect(result.status).toBe('unknown'); expect(f.local.settings.read().nodes[0].enabled).toBe(false);
    expect(result.private_data.local.pairing.status).toBe('intent'); expect(f.local.credentials.read().nodes).toEqual([]);
    expect(f.local.observe(result)).toEqual({ registration: 'matching', pairing: 'missing' });
    noPublicSecrets(result, result.private_data.local.pairing.auth);
    expect(fs.readdirSync(f.config.home).some(name => name.endsWith('.tmp'))).toBe(false);
  } finally { spy?.mockRestore(); await f.close(); }
});

for (const change of ['enabled', 'budget', 'credentials', 'rename', 'unrelated_credentials']) test(`latest central ${change} change is checked without rollback, global-revision coupling or new credentials`, async () => {
  const f = fixture();
  try {
    const result = await f.run({ after_pair() {
      if (change === 'credentials' || change === 'unrelated_credentials') {
        f.local.credentials.save({ node_id: change === 'credentials' ? f.row.id : randomUUID(), machine_token: 'a'.repeat(64) }, f.local.credentials.read().revision);
      } else {
        const view = f.local.settings.read();
        f.local.settings.save({ nodes: view.nodes.map(node => ({ ...node,
          ...(change === 'enabled' ? { enabled: true } : change === 'budget' ? { budgets: { ...budgets, timeout_ms: 30000 } } : { name: 'Display rename' }) })) }, view.revision);
      }
    } });
    const accepted = ['rename', 'unrelated_credentials'].includes(change);
    expect(result.status).toBe(accepted ? 'planned' : 'unknown'); expect(Boolean(f.auth)).toBe(accepted);
    if (change === 'credentials') expect(f.local.observe(result).pairing).toBe('changed');
    if (change === 'enabled' || change === 'budget') expect(f.local.observe(result).registration).toBe('changed');
    expect(result.private_data.local.pairing.status).toBe('complete');
  } finally { await f.close(); }
});

for (const stage of ['registration', 'pairing']) test(`concurrent unrelated ${stage} write preserves CAS and cannot be overwritten or retried`, async () => {
  const f = fixture(); let spy, calls = 0;
  try {
    const service = stage === 'registration' ? f.local.settings : f.local.credentials;
    const method = stage === 'registration' ? 'registerDeployment' : 'pairDeployment', original = service[method].bind(service), other = randomUUID();
    spy = spyOn(service, method).mockImplementation((...args) => {
      calls++;
      if (stage === 'registration') {
        const view = service.read();
        service.save({ nodes: [...view.nodes, { name: 'Unrelated', ssh_alias: 'other', enabled: true, budgets }] }, view.revision);
      } else service.save({ node_id: other, machine_token: 'c'.repeat(64) }, service.read().revision);
      return original(...args);
    });
    const result = await f.run();
    expect(result.status).toBe('unknown'); expect(calls).toBe(1);
    expect(f.local.observe(result)).toEqual(stage === 'registration' ? { registration: 'missing', pairing: 'unrecorded' } : { registration: 'matching', pairing: 'missing' });
    if (stage === 'registration') expect(f.local.settings.read().nodes.map(node => node.ssh_alias)).toEqual(['other']);
    else expect(f.local.credentials.read().nodes.map(node => node.node_id)).toEqual([other]);
    expect(result.private_data.local[stage].status).toBe('intent');
  } finally { spy?.mockRestore(); await f.close(); }
});

test('missing or invalid frozen node budgets cannot be replaced by an implicit current default', async () => {
  for (const invalid of [null, { ...budgets, timeout_ms: 0 }]) {
    const f = fixture();
    try {
      const { node_budgets, ...plan } = f.row.plan;
      if (invalid) plan.node_budgets = invalid;
      f.row = f.store.create({ ...f.row, id: randomUUID(), ssh_alias: 'invalid-budget', plan, private_data: { plan_sha256: hash(stable(plan)) } });
      const result = await f.run();
      expect(result.status).toBe('unknown'); expect(result.private_data.local).toBeUndefined();
      expect(f.local.settings.read().nodes).toEqual([]); expect(f.local.credentials.read().nodes).toEqual([]);
    } finally { await f.close(); }
  }
});

test('an internally inconsistent frozen plan hash cannot authorize local writes even when the approval repeats it', async () => {
  const f = fixture();
  try {
    f.row = f.store.create({ ...f.row, id: randomUUID(), ssh_alias: 'corrupt-plan', private_data: { plan_sha256: '0'.repeat(64) } });
    const result = await f.run();
    expect(result.status).toBe('unknown'); expect(result.private_data.local).toBeUndefined();
    expect(f.local.settings.read().nodes).toEqual([]); expect(f.local.credentials.read().nodes).toEqual([]);
  } finally { await f.close(); }
});

test('async journal guards/checkpoints cannot dispatch actual local registration or credential writes', async () => {
  for (const method of ['guard', 'checkpoint']) {
    const f = fixture();
    try {
      const result = await f.run({ local_context: context => ({ ...context, [method]: async (...args) => context[method](...args) }) });
      expect(result.status).toBe('unknown'); expect(f.local.settings.read().nodes).toEqual([]); expect(f.local.credentials.read().nodes).toEqual([]);
    } finally { await f.close(); }
  }
});

test('rotation immediately after validation cannot substitute newly unapproved credentials into the verifier snapshot', async () => {
  const f = fixture(); let spy, rotated = false;
  try {
    const result = await f.run({ after_pair() {
      const snapshot = f.local.credentials.snapshot.bind(f.local.credentials);
      spy = spyOn(f.local.credentials, 'snapshot').mockImplementation((...args) => {
        const original = snapshot(...args);
        if (!rotated) { rotated = true; f.local.credentials.save({ node_id: f.row.id, machine_token: 'd'.repeat(64) }, f.local.credentials.read().revision); }
        return original;
      });
    } });
    expect(rotated).toBe(true); expect(result.status).toBe('planned');
    expect(f.auth).toEqual(result.private_data.local.pairing.auth); expect(f.auth.machine_token).not.toBe('d'.repeat(64));
    expect(f.local.observe(result).pairing).toBe('changed'); // Observation/next guard detects drift; this read did not freeze the file.
  } finally { spy?.mockRestore(); await f.close(); }
});

test('trusted fresh-ID and pairing paths reject async guards, existing credential entries and unauthorized extra fields', async () => {
  const f = fixture();
  try {
    const node = { id: f.row.id, name: f.row.name, ssh_alias: f.row.ssh_alias, budgets };
    expect(() => f.local.settings.registerDeployment(node, f.local.settings.read().revision, async () => {})).toThrow('synchronous');
    const pair = { node_id: f.row.id, project_id: f.row.project_id, machine_token: 'a'.repeat(64), control_token: 'b'.repeat(64) };
    expect(() => f.local.credentials.pairDeployment(pair, 'absent', async () => {})).toThrow('synchronous');
    expect(() => f.local.settings.registerDeployment({ ...node, enabled: true }, f.local.settings.read().revision, () => {})).toThrow('fields');
    expect(f.local.settings.read().nodes).toEqual([]); expect(f.local.credentials.read().nodes).toEqual([]);
    const saved = f.local.credentials.save(pair, 'absent');
    expect(() => f.local.credentials.pairDeployment(pair, saved.revision, () => {})).toThrow('overwrite');
    expect(f.local.credentials.read()).toEqual(saved);
  } finally { await f.close(); }
});
