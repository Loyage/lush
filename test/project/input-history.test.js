import { test, expect, setDefaultTimeout } from 'bun:test';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { fixture, repo, git, gate, until } from '../helpers.js';
import { Store } from '../../src/persistence/store.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { assertAllowed } from '../../src/rpc/registry.js';
setDefaultTimeout(15000);

const reference = { version: 1, kind: 'text', target: {}, label: 'quote', quote: 'saved selection', location: {}, captured_at: '2026-01-01T00:00:00.000Z' };
const setup = async () => { const f = fixture(); f.project.stopping = true; await repo(f.root); f.call = (method, params = {}) => new Dispatcher(f.project).dispatch(method, params); return f; };
function insert(f, content, status, calls = 1, integration = 'none', reservation = null) {
  return f.store.transaction(() => {
    const inputId = f.store.nextInputId();
    f.store.run('INSERT INTO inputs(id,content) VALUES (?,?)', inputId, content);
    const task = f.store.create({ input_id: inputId, role: 'agent', task_kind: 'order', goal: content });
    f.store.update(task.id, { status, calls, integration, reservation: reservation ? JSON.stringify(reservation) : null });
    f.store.run('UPDATE inputs SET task_id=? WHERE id=?', task.id, inputId);
    return { inputId, taskId: task.id };
  });
}

test('history projects all task states independently of current delivery, preserves orphan inputs and excludes messages/submitted drafts', async () => {
  const f = await setup();
  try {
    const statuses = ['queued','running','waiting','awaiting','paused','awaiting_acceptance','completed','failed','cancelled'];
    for (const status of statuses) {
      const { inputId } = insert(f, `body ${status}`, status);
      expect(f.project.inputGet('input', inputId)).toMatchObject({ status, integration: 'none', merge_status: 'none' });
      expect(f.project.inputHistory({ status }).items).toHaveLength(1);
    }
    const created = insert(f, 'not called', 'paused', 0);
    expect(f.project.inputGet('input', created.inputId).status).toBe('created');
    // Retry resets calls, not the lifetime invocation history: paused is not "never started".
    const retried = insert(f, 'retried then paused', 'paused', 0);
    f.store.update(retried.taskId, { agent_wakes: 1 });
    expect(f.project.inputGet('input', retried.inputId).status).toBe('paused');
    expect(f.project.inputHistory({ status: 'created' }).items.map(item => item.id)).toEqual([created.inputId]);
    const strange = insert(f, 'future', 'future_state');
    expect(f.project.inputGet('input', strange.inputId).status).toBe('unknown');
    const matrix = [
      [null, 'merged'], ['pending', 'none'], ['requested', 'merging'], ['executing', 'merging'],
      ['resolving', 'merging'], ['suspended', 'blocked'], ['blocked', 'blocked'], ['integrated', 'merged'],
    ];
    for (const [stage, expected] of matrix) {
      const row = insert(f, `merge ${stage}`, 'awaiting_acceptance', 1, 'merged', stage ? { version: 2, kind: 'merge', status: stage } : null);
      expect(f.project.inputGet('input', row.inputId)).toMatchObject({ status: 'awaiting_acceptance', integration: 'merged', merge_status: expected });
      expect(f.project.inputHistory({ integration: expected }).items.some(item => item.id === row.inputId && item.kind === 'input')).toBe(true);
    }
    for (const [integration, expected] of [['merging','merging'], ['conflict','blocked'], ['review','blocked']]) {
      const row = insert(f, `legacy ${integration}`, 'waiting', 1, integration);
      expect(f.project.inputGet('input', row.inputId).merge_status).toBe(expected);
    }
    const repair = insert(f, 'actively repairing', 'running', 1, 'pending', {
      version: 2, kind: 'merge', status: 'resolving', blocked_reason: 'fixed parent; source Agent repairing',
    });
    expect(f.project.inputGet('input', repair.inputId).merge_status).toBe('merging');
    const blocked = insert(f, 'blocked reason', 'waiting', 1, 'pending', { version: 1, kind: 'merge', status: 'requested', blocked_reason: 'moved' });
    expect(f.project.inputGet('input', blocked.inputId).merge_status).toBe('blocked');
    const prior = insert(f, 'old delivery not current', 'running', 2, 'merged');
    f.store.event(prior.taskId, 'task.merge_integrated', {});
    f.store.event(prior.taskId, 'task.iteration_started', {});
    expect(f.project.inputGet('input', prior.inputId).merge_status).toBe('none');
    f.store.event(prior.taskId, 'task.merge_integrated', {});
    expect(f.project.inputGet('input', prior.inputId).merge_status).toBe('merged');
    const orphan = f.store.nextInputId();
    f.store.run('INSERT INTO inputs(id,content,task_id) VALUES (?,?,?)', orphan, 'orphan history', 99999);
    expect(f.project.inputGet('input', orphan)).toMatchObject({ status: 'unknown', task_id: null, parent_id: null, revision: null });
    f.store.message(created.taskId, 'only in a followup', null);
    expect(f.project.inputHistory({ q: 'only in a followup' }).items).toEqual([]);
    const d = await f.call('draft.add', { content: 'submitted once' });
    await f.call('order.submit', { draft_id: d.id, expected_revision: d.revision });
    expect(f.project.inputHistory({ q: 'submitted once' }).items.map(item => item.kind)).toEqual(['input']);
  } finally { await f.close(); }
});

test('full-body literal search and exact filters precede stable bounded cursor pagination, including same-time ids', async () => {
  const f = await setup();
  try {
    f.store.transaction(() => {
      for (let i = 0; i < 130; i++) insert(f, `${'x'.repeat(1100)} NEEDLE_% ${i}`, i % 2 ? 'running' : 'completed');
    });
    const draft = await f.call('draft.add', { content: 'NEEDLE_% draft' });
    f.store.run("UPDATE inputs SET created_at='2026-01-01T00:00:00.000Z'");
    f.store.run("UPDATE drafts SET created_at='2026-01-01T00:00:00.000Z'");
    let cursor, seen = [], pages = 0;
    do {
      const page = f.project.inputHistory({ q: 'needle_%', limit: 13, ...(cursor ? { cursor } : {}) });
      expect(page.items.length).toBeLessThanOrEqual(13);
      seen.push(...page.items.map(item => `${item.kind}:${item.id}`)); cursor = page.next_cursor; pages++;
      if (pages === 1) {
        expect(page.items[0].content_truncated).toBe(true);
        expect(page.items[0].content.length).toBe(1000);
        expect(() => f.project.inputHistory({ cursor, q: 'different' })).toThrow('changed filters');
        // Newer insertions cannot shift the remaining page boundaries.
        insert(f, 'NEEDLE_% newly inserted', 'running');
      }
    } while (cursor);
    expect(seen).toHaveLength(131); expect(new Set(seen).size).toBe(131);
    expect(seen.at(-1)).toBe(`draft:${draft.id}`);
    expect(f.project.inputGet('input', 1).content).toContain('NEEDLE_%');
    expect(f.project.inputGet('input', 1).content_truncated).toBe(false);
    expect(f.project.inputHistory({ status: 'completed', limit: 100 }).items).toHaveLength(65);
    expect(f.project.inputHistory({ q: "' OR 1=1 --" }).items).toEqual([]);
    expect(() => f.project.inputHistory({ cursor: 'e30' })).toThrow('invalid input history cursor');
    for (const limit of [0, 101, 1.5, '10', null]) expect(() => f.project.inputHistory({ limit })).toThrow('limit');
    for (const filter of [{ status: 'all' }, { integration: 'pending' }, { q: null }, { q: 'x'.repeat(1001) }]) expect(() => f.project.inputHistory(filter)).toThrow();
  } finally { await f.close(); }
});

test('buffer remembers parent identity across branch switches, freezes baseline only at firing, preserves references and supports create-only/default start', async () => {
  const f = await setup();
  try {
    const d = await f.call('draft.add', { content: '  exact\nbody  ', references: [reference] });
    expect(d).toMatchObject({ kind: 'draft', revision: 1, status: 'draft', branch: 'main', references: [reference] });
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM branches')).toHaveLength(0);
    await git(f.root, 'commit', '--allow-empty', '-m', 'new baseline');
    const next = await git(f.root, 'rev-parse', 'HEAD');
    await git(f.root, 'checkout', '-b', 'unbound');
    const edited = await f.call('draft.update', { id: d.id, content: d.content, expected_revision: 1 });
    expect(edited).toMatchObject({ parent_id: d.parent_id, branch: 'main', revision: 2, references: [reference] });
    const sent = await f.call('order.submit', { draft_id: d.id, expected_revision: 2, start: false });
    expect(sent.task).toMatchObject({ parent_id: d.parent_id, base_commit: next, status: 'paused', calls: 0 });
    expect(f.project.inputGet('input', sent.id)).toMatchObject({ content: d.content, status: 'created', references: [{ segment: 1, ...reference }] });
    await expect(f.call('order.submit', { draft_id: d.id, expected_revision: 2 })).rejects.toThrow('already submitted');
    const owner = await f.project.bindBranch('unbound', next);
    const another = await f.call('draft.add', { content: 'auto parent now unbound' });
    expect(another.parent_id).toBe(owner.id);
    const reassigned = await f.call('draft.update', { id: another.id, content: 'new parent', branch: 'main', references: [], expected_revision: 1 });
    expect(reassigned.parent_id).toBe(d.parent_id);
    const started = await f.call('order.submit', { draft_id: another.id, expected_revision: 2 });
    expect(started.task.status).toBe('queued');
  } finally { await f.close(); }
});

test('strict revision locking rejects overwrite/delete/fire races and never reuses deleted draft ids', async () => {
  const f = await setup();
  try {
    const d = await f.call('draft.add', { content: 'first' });
    await expect(f.call('draft.update', { id: d.id, content: 'missing revision' })).rejects.toThrow('expected_revision');
    const updates = await Promise.allSettled(['a','b'].map(content => f.call('draft.update', { id: d.id, content, expected_revision: 1 })));
    expect(updates.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    await expect(f.call('draft.remove', { id: d.id, expected_revision: 1 })).rejects.toThrow('changed');
    await expect(f.call('order.submit', { draft_id: d.id, expected_revision: 1 })).rejects.toThrow('changed');
    await f.call('draft.remove', { id: d.id, expected_revision: 2 });
    const next = await f.call('draft.add', { content: 'next' });
    expect(next.id).toBeGreaterThan(d.id);
    const results = await Promise.allSettled([1,2].map(() => f.call('order.submit', { draft_id: next.id, expected_revision: 1 })));
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(1);
    const branches = await git(f.root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/lush/');
    expect(branches.split('\n')).toHaveLength(1);
  } finally { await f.close(); }
});

for (const action of ['edit','delete','parent_ended']) test(`async anchor race: ${action} prevents stale submission and removes its checkout`, async () => {
  const f = await setup();
  try {
    const d = await f.call('draft.add', { content: 'original', references: [reference] });
    const ready = gate(), resume = gate(), original = f.project.anchorInput.bind(f.project);
    let anchor;
    f.project.anchorInput = async (...args) => { const result = await original(...args); anchor = result.anchor; ready.resolve(); await resume.promise; return result; };
    const pending = f.call('order.submit', { draft_id: d.id, expected_revision: 1 });
    const failure = pending.then(() => null, error => error);
    await ready.promise;
    if (action === 'edit') await f.call('draft.update', { id: d.id, content: 'edited', expected_revision: 1 });
    if (action === 'delete') await f.call('draft.remove', { id: d.id, expected_revision: 1 });
    if (action === 'parent_ended') f.store.update(d.parent_id, { status: 'completed' });
    resume.resolve(); expect(await failure).toBeInstanceOf(Error);
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0);
    expect(await git(f.root, 'branch', '--list', anchor.branch)).toBe('');
    if (action !== 'delete') expect(f.project.inputGet('draft', d.id).references).toEqual([reference]);
  } finally { await f.close(); }
});

test('legacy drafts remain unowned/unversioned on reopen, require explicit parent edit, and RPC writes survive restart', async () => {
  const f = await setup();
  try {
    const legacy = f.project.draft('legacy', [reference]);
    const fresh = await f.call('draft.add', { content: 'fresh' });
    let reopened = new Store(path.join(f.config.home, 'project.db'), f.root);
    expect(reopened.draft(legacy.id)).toMatchObject({ parent_id: null, revision: null, content: 'legacy' });
    expect(reopened.draft(fresh.id)).toMatchObject({ parent_id: fresh.parent_id, revision: 1 });
    expect(reopened.draftReferences(legacy.id)).toEqual([reference]); reopened.close();
    await expect(f.call('order.submit', { draft_id: legacy.id, expected_revision: null })).rejects.toThrow('no saved parent');
    const unowned = await f.call('draft.update', { id: legacy.id, content: 'still legacy', expected_revision: null });
    expect(unowned.parent_id).toBeNull();
    const owned = await f.call('draft.update', { id: legacy.id, content: 'legacy ready', branch: 'main', expected_revision: 1 });
    expect(owned.parent_id).toBe(fresh.parent_id);
    await f.call('order.submit', { draft_id: legacy.id, expected_revision: 2 });
    reopened = new Store(path.join(f.config.home, 'project.db'), f.root);
    expect(reopened.draft(legacy.id).input_id).not.toBeNull(); reopened.close();
    // Real old schema: added numeric fields remain NULL without rewriting content/timestamps.
    const oldPath = path.join(f.root, 'old.db'), db = new Database(oldPath);
    db.exec("CREATE TABLE drafts(id INTEGER PRIMARY KEY,content TEXT NOT NULL,input_id INTEGER,created_at TEXT NOT NULL); INSERT INTO drafts VALUES(7,'untouched',NULL,'old stamp')"); db.close();
    const upgraded = new Store(oldPath, f.root);
    expect(upgraded.draft(7)).toEqual({ id: 7, content: 'untouched', input_id: null, created_at: 'old stamp', parent_id: null, revision: null }); upgraded.close();
  } finally { await f.close(); }
});

test('parent choices enumerate beyond overview, omit ended/missing/archived ancestors, and explicitly fail on overflow', async () => {
  const f = await setup();
  try {
    const d = await f.call('draft.add', { content: 'old root' });
    f.store.transaction(() => {
      for (let i = 0; i < 260; i++) f.store.create({ role: 'agent', goal: 'newer unrelated Task' });
    });
    expect((await f.call('input.parents')).items).toEqual([{ id: d.parent_id, worker_number: null, branch: 'main', goal: '管理 main 分支及子Worker合并请求', freeze: null }]);
    const sent = await f.call('order.submit', { content: 'eligible order', start: false });
    expect((await f.call('input.parents')).items.map(item => item.id)).toContain(sent.task.id);
    const sub = await f.call('draft.add', { content: 'under order', branch: sent.task.branch });
    f.store.update(sent.task.id, { status: 'completed' });
    await expect(f.call('order.submit', { draft_id: sub.id, expected_revision: 1 })).rejects.toThrow('no longer available');
    expect((await f.call('input.parents')).items.map(item => item.id)).not.toContain(sent.task.id);
    await git(f.root, 'branch', 'missing-later');
    const owner = await f.project.bindBranch('missing-later', await git(f.root, 'rev-parse', 'main'));
    const missing = await f.call('draft.add', { content: 'missing ref', branch: owner.branch });
    await git(f.root, 'branch', '-d', owner.branch);
    await expect(f.call('order.submit', { draft_id: missing.id, expected_revision: 1 })).rejects.toThrow('does not exist');
    expect((await f.call('input.parents')).items.map(item => item.id)).not.toContain(owner.id);
    f.store.transaction(() => {
      for (let i = 0; i < 2001; i++) {
        const task = f.store.create({ role: 'agent', goal: 'bound', task_kind: 'owner' });
        f.store.update(task.id, { branch: `bound-${i}` });
      }
    });
    await expect(f.call('input.parents')).rejects.toThrow('too many parent Worker candidates');
  } finally { await f.close(); }
});

test('new RPC methods are user-only, strictly validate params, and legacy planner entrypoints stay closed', async () => {
  const f = await setup();
  try {
    for (const method of ['input.history','input.get','input.parents','draft.add','draft.update','draft.remove','order.submit']) {
      expect(() => assertAllowed(method, {}, 1)).toThrow('requires user approval');
      await expect(f.call(method, { alien: 1 })).rejects.toThrow('unknown parameter');
    }
    for (const method of ['input.submit','draft.commit','draft.list','input.list']) await expect(f.call(method)).rejects.toThrow('unknown method');
    for (const params of [{ content: '' }, { content: 'x'.repeat(32001) }, { content: 'ok', references: null }, { content: 'ok', branch: null }]) await expect(f.call('draft.add', params)).rejects.toThrow();
    for (const start of ['false', 0, null]) await expect(f.call('order.submit', { content: 'x', start })).rejects.toThrow('boolean');
    for (const field of ['content','references','branch']) await expect(f.call('order.submit', { draft_id: 1, expected_revision: 1, [field]: 'x' })).rejects.toThrow('cannot be combined');
    await expect(f.call('order.submit', { draft_id: 1 })).rejects.toThrow('expected_revision');
    await expect(f.call('input.get', { kind: 'task', id: 1 })).rejects.toThrow('kind');
    await expect(f.call('input.get', { kind: 'input', id: 1.1 })).rejects.toThrow('id');
  } finally { await f.close(); }
});

test('buffering tolerates temporary parent invocation/sync/freeze but firing uses full admission', async () => {
  const f = await setup();
  try {
    const parent = await f.project.order('busy parent', 'main', [], null, false);
    f.store.update(parent.task.id, { status: 'running' });
    f.project.taskSyncBusy = new Set([parent.task.id]);
    const original = f.project.assertBranchWritable;
    f.project.assertBranchWritable = () => { throw new Error('temporarily frozen'); };
    const draft = await f.call('draft.add', { content: 'save my idea', branch: parent.task.branch });
    expect(draft.parent_id).toBe(parent.task.id);
    expect((await f.call('input.parents')).items.map(row => row.id)).toContain(parent.task.id);
    await expect(f.call('order.submit', { draft_id: draft.id, expected_revision: 1 })).rejects.toThrow('temporarily frozen');
    expect(f.project.inputGet('draft', draft.id).content).toBe('save my idea');
    f.project.assertBranchWritable = original;
    f.project.taskSyncBusy.clear();
  } finally { await f.close(); }
});

test('draft start=false does not invoke an Agent; default start runs the normal order lifecycle', async () => {
  const f = fixture(); await repo(f.root);
  const call = (method, params) => new Dispatcher(f.project).dispatch(method, params);
  try {
    const d = await call('draft.add', { content: 'create only' });
    const paused = await call('order.submit', { draft_id: d.id, expected_revision: 1, start: false });
    const next = await call('draft.add', { content: 'actually run' });
    const running = await call('order.submit', { draft_id: next.id, expected_revision: 1 });
    await until(() => f.store.task(running.task.id).status === 'waiting');
    expect(f.store.task(running.task.id).calls).toBe(1);
    expect(f.store.task(paused.task.id)).toMatchObject({ status: 'paused', calls: 0 });
  } finally { await f.close(); }
});

test('Git error after creating a self-owned anchor cleans it and leaves the buffered snapshot intact', async () => {
  const f = await setup();
  try {
    const d = await f.call('draft.add', { content: 'do not lose me', references: [reference] });
    const ws = f.project.workspaces, original = ws.git.bind(ws);
    ws.git = async (cwd, ...args) => {
      const result = await original(cwd, ...args);
      if (args[0] === 'worktree' && args[1] === 'add') throw new Error('simulated Git failure after creation');
      return result;
    };
    await expect(f.call('order.submit', { draft_id: d.id, expected_revision: 1 })).rejects.toThrow('simulated Git');
    expect(f.project.inputGet('draft', d.id)).toEqual(d);
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0);
    expect(await git(f.root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/lush/')).toBe('');
  } finally { await f.close(); }
});
