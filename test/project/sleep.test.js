import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, until, gate, repo, git } from '../helpers.js';
import { Project } from '../../src/core/project.js';
import { assertAllowed } from '../../src/rpc/registry.js';
import { recommendedChoice } from '../../src/core/sleep-policy.js';

const options = { mode: 'recommended', budget_tokens: null, include_existing: true, allow_merge: false };
const questions = [{ header: '设计', question: '选哪个？', options: [
  { label: 'A', description: '方案 A' }, { label: 'B（推荐）', description: '方案 B' },
] }];
function owner(f, role = 'research') {
  const task = f.store.create({ role, goal: '继续开发', input_id: null });
  f.store.update(task.id, { status: 'awaiting' }); return task;
}
const result = f => f.project.sleepChoices().choices[0]?.result;
async function applied(f) { return until(() => result(f)?.status === 'applied' && !f.project.sleepTickPromise); }

test('sleep requires explicit user confirmation, valid options, and isolated backend', async () => {
  const f = fixture();
  try {
    expect(() => f.project.startSleep(options, false)).toThrow('确认');
    expect(() => f.project.startSleep({ ...options, budget_tokens: -1 }, true)).toThrow('budget_tokens');
    expect(() => f.project.startSleep({ ...options, allow_merge: 'yes' }, true)).toThrow('explicitly');
    expect(f.project.sleepStatus().enabled).toBe(false);
    for (const method of ['sleep.start','sleep.stop','sleep.resume','sleep.status','sleep.choices']) {
      expect(() => assertAllowed(method, {}, 1)).toThrow('requires user');
    }
    f.project.provider.resolve = () => ({ agent: 'codex' });
    expect(() => f.project.startSleep(options, true)).toThrow('Pi');
  } finally { await f.close(); }
});

test('rule mode selects recommendation once and retains the exact decision snapshot after stop', async () => {
  const f = fixture();
  try {
    const task = owner(f), notice = f.project.notice(task.id, '选设计', '补充', 'question', questions);
    f.project.startSleep(options, true);
    await Promise.all([f.project.sleepTick(), f.project.sleepTick(), f.project.sleepTick()]); await applied(f);
    expect(f.project.sleepStatus()).toMatchObject({ handled: 1, decisions: 1 });
    const row = f.store.get('SELECT * FROM notices WHERE id=?', notice.id);
    expect(JSON.parse(row.answer).answers[0].selected).toEqual([1]);
    expect(f.store.tasks().some(t => t.role === 'butler')).toBe(false);
    f.project.stopSleep();
    const choice = f.project.sleepChoices().choices[0];
    expect(choice.notice.body).toBe(notice.body); expect(choice.result.decision.reason).toContain('推荐');
    expect(f.project.sleepChoices().choices).toHaveLength(1);
    expect(f.project.sleepStatus().enabled).toBe(false);
    expect(f.project.sleepPreferenceHistory()[0].decided_by).toBe('butler');
  } finally { await f.close(); }
});

test('session progress counts a finished info reminder as handled but not as a choice', async () => {
  const f = fixture();
  try {
    const question = f.project.notice(owner(f).id, '选设计', '补充', 'question', questions);
    f.project.startSleep(options, true);
    await applied(f);
    expect(f.project.sleepStatus()).toMatchObject({ handled: 1, decisions: 1 });
    f.project.notify(owner(f).id, '开发完成', '供参考');
    await until(() => { void f.project.sleepTick(); return f.project.sleepStatus().handled === 2; });
    expect(f.project.sleepStatus()).toMatchObject({ handled: 2, decisions: 1 });
    const info = f.project.sleepChoices().choices.find(choice => choice.notice.title === '开发完成');
    expect(info.result).toMatchObject({ status: 'applied', decision: { action: 'acknowledge' } });
    expect(f.store.get('SELECT status FROM notices WHERE id=?', question.id).status).toBe('answered');
  } finally { await f.close(); }
});

test('existing notice scope is opt-in; new plans are approved through the plan gate', async () => {
  const f = fixture();
  try {
    const old = f.project.notice(owner(f).id, '旧问题');
    f.project.startSleep({ ...options, include_existing: false }, true);
    await f.project.sleepTick();
    expect(f.store.get('SELECT status FROM notices WHERE id=?', old.id).status).toBe('open');
    const planner = owner(f, 'planner'); f.store.update(planner.id, { plan_gate: 'proposed' });
    const notice = f.project.notice(planner.id, '请批准', '范围', 'plan');
    await f.project.sleepTick(); await applied(f);
    expect(f.store.task(planner.id).plan_gate).toBe('approved');
    expect(f.store.get('SELECT status FROM notices WHERE id=?', notice.id).status).toBe('answered');
  } finally { await f.close(); }
});

test('preference mode gets bounded human history and cannot use tools/RPC or create worktrees', async () => {
  let received;
  const held = gate();
  const f = fixture({ resolve: () => ({ agent: 'mock' }), async run(value) {
    if (value.task.role !== 'butler') return 'done';
    received = value; await held.promise;
    return JSON.stringify({ action: 'answer', answer: { answers: [{ selected: [0] }] }, reason: '参考过去用户选择 A；仍存在不确定性。' });
  } });
  try {
    const prior = owner(f); const priorNotice = f.project.notice(prior.id, '以前的决定');
    f.project.answer(priorNotice.id, '偏好方案 A'); await until(() => f.store.task(prior.id).status === 'completed');
    const task = owner(f), notice = f.project.notice(task.id, '新问题', '', 'question', questions);
    f.project.startSleep({ ...options, mode: 'preferences' }, true);
    await until(() => received);
    expect(received.context.butler.history[0]).toMatchObject({ answer: '偏好方案 A', decided_by: 'user' });
    expect(() => f.project.actor(received.token)).toThrow('no RPC capability');
    expect(f.store.task(received.task.id).workspace).toBeNull();
    expect(() => f.project.spawn(received.task.id, '开发', 'research')).toThrow('cannot delegate');
    held.resolve(); await applied(f);
    expect(JSON.parse(f.store.get('SELECT answer FROM notices WHERE id=?', notice.id).answer).answers[0].selected).toEqual([0]);
    expect(result(f).decision.reason).toContain('用户');
  } finally { held.resolve(); await f.close(); }
});

test('no recommended option falls back to butler; invalid output is audited without settling notice or retry loops', async () => {
  let calls = 0;
  const f = fixture({ resolve: () => ({ agent: 'mock' }), async run() { calls++; return 'not JSON'; } });
  try {
    const notice = f.project.notice(owner(f).id, '自由文本问题');
    f.project.startSleep(options, true);
    await until(() => result(f)?.status === 'failed' && f.project.running.size === 0);
    await f.project.sleepTick();
    expect(calls).toBe(1); expect(f.store.get('SELECT status FROM notices WHERE id=?', notice.id).status).toBe('open');
    expect(result(f).raw).toBe('not JSON');
  } finally { await f.close(); }
});

test('stop invalidates an in-flight decision and keeps an interruption receipt', async () => {
  const held = gate(); let entered = false;
  const f = fixture({ resolve: () => ({ agent: 'mock' }), async run() { entered = true; await held.promise; return JSON.stringify({ action: 'answer', answer: '同意', reason: '推断' }); } });
  try {
    const notice = f.project.notice(owner(f).id, '问题');
    f.project.startSleep(options, true); await until(() => entered);
    f.project.stopSleep(); held.resolve(); await until(() => f.project.running.size === 0);
    expect(f.store.get('SELECT status FROM notices WHERE id=?', notice.id).status).toBe('open');
    expect(result(f).status).toBe('interrupted');
  } finally { held.resolve(); await f.close(); }
});

test('human answer wins over a stale butler answer and remains human preference evidence', async () => {
  const held = gate(); let entered = false;
  const f = fixture({ resolve: () => ({ agent: 'mock' }), async run({ task }) {
    if (task.role !== 'butler') return 'done';
    entered = true; await held.promise; return JSON.stringify({ action: 'answer', answer: '代理答案', reason: '推断' });
  } });
  try {
    const notice = f.project.notice(owner(f).id, '问题');
    f.project.startSleep(options, true); await until(() => entered);
    f.project.answer(notice.id, '人工答案'); held.resolve();
    await until(() => result(f)?.status === 'skipped');
    expect(f.store.get('SELECT answer FROM notices WHERE id=?', notice.id).answer).toBe('人工答案');
    expect(f.project.sleepPreferenceHistory()[0].decided_by).toBe('user');
  } finally { held.resolve(); await f.close(); }
});

test('budget counts all roles plus cache tokens; stops invocations, persists pause, and resume does not replay them', async () => {
  let started = 0;
  const f = fixture({ resolve: () => ({ agent: 'mock' }), async run({ signal }) {
    started++; await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); throw new Error('aborted');
  } });
  try {
    f.project.startSleep({ ...options, budget_tokens: 10 }, true);
    const task = f.store.create({ role: 'research', goal: 'running', input_id: null }); f.project.kick();
    await until(() => started === 1);
    const queued = f.store.create({ role: 'research', goal: 'queued', input_id: null });
    const dir = path.join(f.config.home, 'sessions'); fs.mkdirSync(dir, { recursive: true });
    for (const [i, role] of ['worker','planner','butler'].entries()) fs.writeFileSync(path.join(dir, `budget_lush-task-${i + 10}.jsonl`), JSON.stringify({
      type: 'message', timestamp: new Date().toISOString(), lush: { task_id: i + 10, role },
      message: { role: 'assistant', usage: { input: 1, output: 1, cacheRead: 2, cacheWrite: 1 } },
    }) + '\n');
    await f.project.sleepTick(); await until(() => f.project.running.size === 0);
    expect(f.project.sleepStatus()).toMatchObject({ used_tokens: 15, enabled: false, paused: true });
    expect(f.store.task(task.id).status).toBe('failed'); expect(f.store.task(queued.id).status).toBe('queued');
    f.project.stopSleep(); expect(f.project.sleepStatus().paused).toBe(true);
    f.project.resumeSleepDevelopment(); await until(() => started === 2);
    expect(f.store.task(task.id).status).toBe('failed');
  } finally { await f.close(); }
});

test('restart preserves authorization but never replays a claimed choice; audits survive source deletion and paginate', async () => {
  const f = fixture(); let restored;
  try {
    const task = owner(f), notice = f.project.notice(task.id, '问题');
    f.project.startSleep(options, true);
    // Claim before scheduling gets the chance to invoke the model, simulating a crash window.
    const source = { session: f.project.sleepStatus().session, mode: options.mode, notice };
    f.store.event(null, 'sleep.choice.started', source);
    await f.project.shutdown();
    restored = new Project(f.config, f.store); restored.recover();
    await restored.sleepTick();
    expect(restored.sleepStatus().enabled).toBe(true);
    expect(restored.sleepChoices().choices[0].result.status).toBe('interrupted');
    expect(f.store.all("SELECT * FROM tasks WHERE role='butler'")).toHaveLength(0);
    restored.stopSleep();
    for (let i = 0; i < 54; i++) f.store.event(null, 'sleep.choice.started', source);
    const first = restored.sleepChoices(null, 30), second = restored.sleepChoices(first.cursor, 30);
    expect(first.choices).toHaveLength(30); expect(second.choices).toHaveLength(25);
    expect(first.has_more).toBe(true); expect(second.has_more).toBe(false);
    f.store.run('DELETE FROM notices WHERE task_id=?', task.id);
    expect(restored.sleepChoices().choices[0].notice.title).toBe('问题');
  } finally { await restored?.shutdown(); await f.close(); }
});

test('automatic merge requires explicit authorization and uses the existing safe merge entry', async () => {
  for (const allowed of [false, true]) {
    const f = fixture(); let calls = 0;
    try {
      const task = owner(f, 'worker'); f.store.update(task.id, { status: 'completed', integration: 'pending' });
      f.project.notify(task.id, '开发完成', '需要合并');
      f.project.approveMerge = async id => { expect(id).toBe(task.id); calls++; return { merge: { status: 'merged' } }; };
      f.project.startSleep({ ...options, allow_merge: allowed }, true); await applied(f);
      expect(calls).toBe(allowed ? 1 : 0);
      expect(result(f).decision.action).toBe(allowed ? 'merge' : 'acknowledge');
    } finally { await f.close(); }
  }
});

test('authorized merge obeys real Git clean-worktree guards and preserves user changes on failure', async () => {
  for (const dirty of [false, true]) {
    const f = fixture();
    try {
      await repo(f.root);
      const task = f.store.create({ role: 'worker', name: 'sleep-test', goal: 'change', input_id: null });
      const workspace = await f.project.workspaces.ensure(task);
      fs.writeFileSync(path.join(workspace, 'added.txt'), 'agent work\n');
      await git(workspace, 'add', 'added.txt'); await git(workspace, 'commit', '-m', 'agent change');
      await f.project.workspaces.finish(f.store.task(task.id));
      f.project.finish(task.id, 'completed', '交付');
      if (dirty) fs.writeFileSync(path.join(f.root, 'file.txt'), 'user uncommitted work\n');
      f.project.startSleep({ ...options, allow_merge: true }, true);
      await until(() => ['applied','failed'].includes(result(f)?.status) && !f.project.sleepTickPromise);
      expect(result(f).status).toBe(dirty ? 'failed' : 'applied');
      expect(f.store.task(task.id).integration).toBe(dirty ? 'pending' : 'merged');
      if (dirty) expect(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8')).toBe('user uncommitted work\n');
      else expect(fs.readFileSync(path.join(f.root, 'added.txt'), 'utf8')).toBe('agent work\n');
    } finally { await f.close(); }
  }
});

test('scope remains correct if notice IDs are reused after deleting the newest source', async () => {
  const f = fixture();
  try {
    const oldTask = owner(f), old = f.project.notice(oldTask.id, '旧问题');
    f.project.startSleep({ ...options, include_existing: false }, true); await f.project.sleepTick();
    f.store.run('DELETE FROM notices WHERE id=?', old.id);
    const task = owner(f), notice = f.project.notice(task.id, '新问题', '', 'question', questions);
    expect(notice.id).toBe(old.id);
    await f.project.sleepTick(); await applied(f);
    expect(f.project.sleepChoices().choices[0].notice.title).toBe('新问题');
  } finally { await f.close(); }
});

test('budget uncertainty fails closed and clearing an enabled project is forbidden', async () => {
  const f = fixture();
  try {
    f.project.startSleep({ ...options, budget_tokens: 50 }, true);
    expect(() => f.project.clear()).toThrow('睡觉模式');
    const dir = path.join(f.config.home, 'sessions'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'unknown_lush-task-1.jsonl'), JSON.stringify({ type: 'message', timestamp: new Date().toISOString(), message: { role: 'assistant' } }) + '\n');
    await f.project.sleepTick();
    expect(f.project.sleepStatus()).toMatchObject({ enabled: false, paused: true });
    expect(f.project.sleepStatus().reason).toContain('无法可靠读取');
  } finally { await f.close(); }
});

test('ambiguous recommendations are not silently treated as the first option', () => {
  const notice = { kind: 'questionnaire', body: JSON.stringify({ questions: [{ ...questions[0], options: [
    { label: 'A (Recommended)' }, { label: 'B（推荐）' },
  ] }] }) };
  expect(recommendedChoice(notice)).toBeNull();
});
