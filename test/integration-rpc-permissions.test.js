import { test, expect } from 'bun:test';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { PARAMS, USER_ONLY, AGENT_ONLY, INTEGRATION_METHODS } from '../src/rpc/registry.js';
import { fixture, repo, gate, until } from './helpers.js';

const allowed = [
  'notice.post','progress.plan','progress.complete','system.status','system.summary',
  'worker.lookup','worker.inspect','worker.diff','worker.history','worker.history_page','worker.transcript',
  'branch.tree','branch.show','graph.get','notice.list','notice.page',
];
function stub(identity = { id: 9, role: 'agent', task_kind: 'integration' }) {
  const calls = [], result = { ok: true };
  const record = name => (...args) => { calls.push([name, ...args]); return result; };
  const p = {
    actor: token => token ? 9 : null,
    store: {
      task: id => id === 9 ? identity : { id, role: 'agent', task_kind: 'child' },
      lookupWorker: record('lookup'), history: record('history'), historyPage: record('historyPage'),
      all: record('all'),
    },
    status: record('status'), summary: record('summary'), inspect: record('inspect'), diff: record('diff'),
    transcript: record('transcript'), branchTree: record('branchTree'), branchShow: record('branchShow'), graph: record('graph'),
    reportProgressPlan: record('plan'), completeProgressStep: record('complete'), notice: record('notice'),
    developmentSummary() { throw new Error('Agent must not receive the user-only development projection'); },
    daemonHooks() { throw new Error('Agent summary must not read Hook authorization'); },
  };
  return { p, calls, result, identity };
}

test('integration capability is an explicit registered allowlist that does not change base permission sets', () => {
  expect([...INTEGRATION_METHODS]).toEqual(allowed);
  for (const method of allowed) {
    expect(PARAMS[method]).toBeDefined(); expect(USER_ONLY.has(method)).toBe(false);
    expect(AGENT_ONLY.has(method)).toBe(method.startsWith('progress.'));
  }
});

test('Dispatcher default-denies every non-allowlisted method for the authenticated integration kind', async () => {
  for (const role of ['agent','worker','merger','coordinator']) {
    const { p, calls } = stub({ id: 9, role, task_kind: 'integration' }), dispatcher = new Dispatcher(p);
    for (const method of Object.keys(PARAMS).filter(method => !INTEGRATION_METHODS.has(method))) {
      await expect(dispatcher.dispatch(method, { _token: 'valid-invocation' }))
        .rejects.toThrow(USER_ONLY.has(method) ? 'requires user approval' : 'integration agents can only');
    }
    expect(calls).toEqual([]);
  }
  // These ordinary Agent methods are especially dangerous for a delivery helper.
  for (const method of ['worker.spawn','worker.integrate','worker.resolve_child_divergence','worker.message','worker.auto_title','worker.accept']) {
    expect(INTEGRATION_METHODS.has(method)).toBe(false);
  }
  for (const method of Object.keys(PARAMS).filter(method => method.startsWith('branch.convergence'))) {
    expect(USER_ONLY.has(method)).toBe(true); expect(INTEGRATION_METHODS.has(method)).toBe(false);
  }
});

test('allowed integration reads pass through existing safe handlers without gaining user projections', async () => {
  const { p, calls, result } = stub(), d = new Dispatcher(p);
  const cases = [
    ['system.status', {}, ['status',false]],
    ['system.summary', { development: true }, ['summary']],
    ['worker.lookup', { number: 'W5' }, ['lookup','W5']],
    ['worker.inspect', { id: 17 }, ['inspect',17]],
    ['worker.diff', { id: 17 }, ['diff',17]],
    ['worker.history', { id: 17, after: 1 }, ['history',17,1]],
    ['worker.history_page', { id: 17, before: 12, limit: 5 }, ['historyPage',17,12,5]],
    ['worker.transcript', { id: 17, after: 1, limit: 5 }, ['transcript',17,1,5]],
    ['branch.tree', {}, ['branchTree']], ['branch.show', { branch: 'main' }, ['branchShow','main']],
    ['graph.get', {}, ['graph']],
  ];
  for (const [method, params, expected] of cases) {
    expect(await d.dispatch(method, { ...params, _token: 'valid-invocation' })).toMatchObject(result);
    expect(calls.at(-1)).toEqual(expected);
  }
  p.store.all = (...args) => { calls.push(['all', ...args]); return []; };
  expect(await d.dispatch('notice.list', { _token: 'valid-invocation' })).toEqual([]);
  expect(await d.dispatch('notice.page', { _token: 'valid-invocation' })).toMatchObject({ notices: [], has_more: false });
  expect(calls).toHaveLength(cases.length + 2);
});

test('own Notice and progress stay actor-bound and caller identity fields cannot widen the helper', async () => {
  const { p, calls } = stub(), d = new Dispatcher(p), token = { _token: 'valid-invocation' };
  await d.dispatch('notice.post', { ...token, title: 'Question', body: 'Details' });
  await d.dispatch('notice.post', { ...token, task: 9, title: 'Question', body: 'Details' });
  await expect(d.dispatch('notice.post', { ...token, task: 17, title: 'Forged owner' })).rejects.toThrow('only for their own worker');
  await d.dispatch('progress.plan', { ...token, steps: ['inspect'] });
  await d.dispatch('progress.complete', { ...token, step: 'inspect' });
  expect(calls).toEqual([
    ['notice',9,'Question','Details','question',undefined], ['notice',9,'Question','Details','question',undefined],
    ['plan',9,['inspect']], ['complete',9,'inspect'],
  ]);
  let authCalls = 0;
  p.actor = () => { authCalls++; return 9; };
  for (const field of ['id','task','actor','role','task_kind','scope']) {
    await expect(d.dispatch('progress.plan', { ...token, steps: ['inspect'], [field]: 17 })).rejects.toThrow('unknown parameter');
    await expect(d.dispatch('progress.complete', { ...token, step: 'inspect', [field]: 17 })).rejects.toThrow('unknown parameter');
  }
  await expect(d.dispatch('notice.post', { ...token, title: 'Q', task_kind: 'order' })).rejects.toThrow('unknown parameter');
  await expect(d.dispatch('integration.spawn', token)).rejects.toThrow('unknown method');
  expect(authCalls).toBe(0); expect(calls).toHaveLength(4);
});

test('task_kind rather than a role label decides capability, preserving ordinary and management guards', async () => {
  for (const identity of [{ id: 9, role: 'agent', task_kind: 'order' }, { id: 9, role: 'agent', task_kind: 'child' },
    { id: 9, role: 'merger', task_kind: null }, { id: 9, role: 'integration', task_kind: 'order' }]) {
    const { p, calls } = stub(identity);
    p.setTaskAutoTitle = (...args) => { calls.push(['autoTitle', ...args]); return { changed: false }; };
    await new Dispatcher(p).dispatch('worker.auto_title', { title: 'Title', _token: 'valid' });
    expect(calls).toEqual([['autoTitle',9,'Title']]);
  }
  for (const identity of [{ id: 9, role: 'manager', task_kind: 'management' },
    { id: 9, role: 'agent', task_kind: 'management' }, { id: 9, role: 'manager', task_kind: 'integration' }]) {
    const { p, calls } = stub(identity), d = new Dispatcher(p);
    await expect(d.dispatch('notice.post', { title: 'Q', _token: 'valid' })).rejects.toThrow('management agents can only');
    await expect(d.dispatch('progress.plan', { steps: ['inspect'], _token: 'valid' })).rejects.toThrow('management agents can only');
    expect(calls).toEqual([]);
    if (identity.task_kind === 'integration') {
      await expect(d.dispatch('manager.query', { _token: 'valid' })).rejects.toThrow('integration agents can only');
    }
  }
  const { p, calls } = stub();
  p.setBranchConvergence = (...args) => { calls.push(['set', ...args]); return { enabled: false }; };
  const d = new Dispatcher(p);
  await expect(d.dispatch('progress.plan', { steps: ['inspect'] })).rejects.toThrow('agent only');
  await d.dispatch('branch.convergence_set', { branch: 'main', enabled: false, validation: null, expected_revision: 'read-revision' });
  expect(calls).toEqual([['set','main',false,null,'read-revision']]);
});

function controlled() {
  const calls = [];
  return { calls, run(ctx) {
    const done = gate(); calls.push({ ...ctx, done });
    if (ctx.signal.aborted) done.resolve('aborted');
    else ctx.signal.addEventListener('abort', () => done.resolve('aborted'), { once: true });
    return done.promise;
  } };
}

test('real authentication rejects a forged helper without a fixed attempt and preserves ordinary invocation expiration', async () => {
  const provider = controlled(), f = fixture(provider); await repo(f.root);
  let task;
  try {
    task = (await f.project.order('controlled RPC capability test')).task;
    await until(() => provider.calls.length === 1);
    const run = f.project.running.get(task.id), token = run.token;
    // A type label on an ordinary invocation is not a helper capability: the Runtime
    // now requires the immutable creation/run/node/generation as well as the live token.
    // Real factory + Dispatcher allowed/denied operations are tested in assembled-workers.
    f.store.run("UPDATE tasks SET task_kind='integration' WHERE id=?", task.id);
    const d = new Dispatcher(f.project), other = f.store.create({ role: 'agent', goal: 'unrelated fixture Worker', task_kind: 'child' });
    for (const [method, params] of [
      ['worker.inspect', { id: task.id }], ['worker.auto_title', { title: 'forbidden' }],
      ['branch.convergence_list', {}], ['notice.post', { title: 'forged capability' }],
      ['progress.plan', { steps: [{ key: 'forged', label: 'Forged' }] }],
    ]) await expect(d.dispatch(method, { ...params, _token: token })).rejects.toThrow('no longer owns the fixed attempt');
    expect(f.store.task(task.id).progress_plan).toBeNull();
    expect(f.store.all('SELECT id FROM notices')).toEqual([]);
    f.store.run("UPDATE tasks SET task_kind='order' WHERE id=?", task.id);
    expect(await d.dispatch('worker.inspect', { id: task.id, _token: token })).toMatchObject({ id: task.id, task_kind: 'order' });
    expect(f.store.task(task.id).agent_last_seen_at).not.toBeNull();
    await expect(d.dispatch('branch.convergence_list', { _token: token })).rejects.toThrow('requires user approval');
    await expect(d.dispatch('notice.post', { task: other.id, title: 'forged', _token: token })).rejects.toThrow('only for their own worker');
    const notice = await d.dispatch('notice.post', { title: 'Which combination?', body: 'Fixture only', _token: token });
    expect(notice).toMatchObject({ task_id: task.id, title: 'Which combination?', kind: 'question' });
    const planned = await d.dispatch('progress.plan', { steps: [
      { key: 'inspect', label: 'Inspect' }, { key: 'verify', label: 'Verify' },
    ], _token: token });
    expect(planned).toMatchObject({ task_id: task.id });
    const completed = await d.dispatch('progress.complete', { step: 'inspect', _token: token });
    expect(completed.progress.items[0]).toMatchObject({ key: 'inspect', status: 'completed' });
    expect(f.store.task(other.id).progress_plan).toBeNull();
    expect(f.store.all("SELECT task_id FROM notices WHERE kind='question'")).toEqual([{ task_id: task.id }]);

    const ownOperations = [
      ['worker.inspect', { id: task.id }], ['notice.post', { title: 'must not be written' }],
      ['progress.plan', { steps: ['forged'] }], ['progress.complete', { step: 'verify' }],
    ];
    const progress = f.store.task(task.id).progress_plan;
    async function denied(expected, credential = token) {
      for (const [method, params] of ownOperations) {
        await expect(d.dispatch(method, { ...params, _token: credential })).rejects.toThrow(expected);
      }
      expect(f.store.task(task.id).progress_plan).toBe(progress);
      expect(f.store.all("SELECT task_id FROM notices WHERE kind='question'")).toEqual([{ task_id: task.id }]);
    }
    await denied('invalid or expired', 'unknown-invocation');
    run.parked = true; await denied('no longer active'); run.parked = false;
    f.store.update(task.id, { status: 'waiting' }); await denied('no longer active');
    f.store.update(task.id, { status: 'running' });

    run.controller.abort();
    await denied(/no longer active|invalid or expired/);
    await until(() => !f.project.running.has(task.id));
    await denied('invalid or expired');
  } finally {
    if (task) f.store.run("UPDATE tasks SET task_kind='order' WHERE id=?", task.id);
    await f.close();
  }
});
