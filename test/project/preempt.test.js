import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, temp, until, gate } from '../helpers.js';
import { PiProvider, AgentPreempted } from '../../src/agent/provider.js';
import lushRuntime from '../../src/agent/pi-runtime.js';

// 安全抢占的桩「pi」：第一轮等 daemon 的请求并在安全边界写 stop 标记后正常退出；之后直接交付。
const STUB = `#!/usr/bin/env bun
import fs from 'node:fs';
const ctx = JSON.parse(process.env.LUSH_RUNTIME_CONTEXT || '{}');
const dir = ctx.preempt_dir, id = ctx.task_id;
fs.mkdirSync(dir, { recursive: true });
const once = dir + '/preempted-once';
const request = dir + '/task-' + id + '.request.json';
if (!fs.existsSync(once)) {
  fs.writeFileSync(dir + '/started-' + ctx.run_id, '1');
  const deadline = Date.now() + Number(process.env.STUB_WAIT_MS || 0);
  while (!fs.existsSync(request) && Date.now() < deadline) { /* 等 daemon 的抢占请求 */ }
  if (fs.existsSync(request)) {
    fs.writeFileSync(once, '1');
    fs.writeFileSync(dir + '/task-' + id + '.stop.json', JSON.stringify({ task_id: id, run_id: ctx.run_id, safe_point: 'turn_end' }));
    process.exit(0);
  }
}
process.stdout.write('stub ' + ctx.role + ' #' + ctx.task_id + ' done');
`;

function stub() {
  const file = path.join(temp(), 'stub-pi.mjs');
  fs.writeFileSync(file, STUB); fs.chmodSync(file, 0o755);
  return file;
}

test('the pi runtime stops only at the turn_end boundary, and only for its own invocation', () => {
  const dir = temp();
  const handlers = new Map(), entries = [];
  const pi = { on: (name, fn) => { handlers.set(name, fn); return () => {}; },
    appendEntry: (type, data) => entries.push({ type, data }) };
  process.env.LUSH_RUNTIME_CONTEXT = JSON.stringify({ task_id: 7, run_id: 3, preempt_dir: dir, soft_budget: {} });
  try {
    lushRuntime(pi);
    expect(handlers.has('turn_end')).toBe(true);
    // 没有请求：什么都不写，也不申请继续下一轮（让本轮正常收尾）。
    expect(handlers.get('turn_end')()).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'task-7.stop.json'))).toBe(false);
    fs.writeFileSync(path.join(dir, 'task-7.request.json'), JSON.stringify({ task_id: 7, run_id: 3, reason: 'user message' }));
    expect(handlers.get('turn_end')()).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'task-7.stop.json'), 'utf8'))).toMatchObject({
      task_id: 7, run_id: 3, safe_point: 'turn_end', reason: 'user message' });
    expect(entries.at(-1)).toMatchObject({ type: 'lush.preempted' });
  } finally { delete process.env.LUSH_RUNTIME_CONTEXT; }
});

test('a boundary marker turns a finished process into AgentPreempted instead of a result', async () => {
  const f = fixture(null, { LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: stub() });
  await repo(f.root);
  try {
    const provider = new PiProvider(f.config);
    const agent = { agent: 'pi', model: '', thinking: '', default_prompt: '', append_prompt: '',
      extensions: [], skills: [], soft_budget: {} };
    const options = { task: { id: 7, role: 'worker', goal: 'stub work', input_id: null },
      context: { invocation: { run_id: 11 } }, messages: [], cwd: f.root, token: 't',
      signal: new AbortController().signal, onSpawn: () => {}, agent };
    expect(await provider.run(options)).toContain('stub worker #7 done');
    const dir = path.join(f.config.home, 'preempt');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'task-7.request.json'), JSON.stringify({ task_id: 7, run_id: 11, reason: 'user message' }));
    // 关闭时进程已经按自己的节奏退出了，但它在安全边界留了标记：按抢占处理，不当作完成。
    await expect(provider.run(options)).rejects.toThrow(AgentPreempted);
    // 标记是一次性的：绝不允许影响下一次 invocation。
    expect(fs.existsSync(path.join(dir, 'task-7.request.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'task-7.stop.json'))).toBe(false);
    expect(await provider.run(options)).toContain('stub worker #7 done');
  } finally { await f.close(); }
});

test('a user message stops the running turn at the safe boundary without failing the task', async () => {
  const f = fixture(null, { LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: stub(), STUB_WAIT_MS: '8000' });
  await repo(f.root);
  try {
    const say = await f.project.say('long running work');
    const dir = path.join(f.config.home, 'preempt');
    await until(() => fs.existsSync(dir) && fs.readdirSync(dir).some(name => name.startsWith('started-')));
    f.project.message(say.task.id, 'urgent correction');
    // 抢占被记成独立结果：不是失败，也没有把 task 结算掉。
    await until(() => f.store.all('SELECT status FROM agent_runs ORDER BY id').some(run => run.status === 'preempted'));
    const task = f.store.task(say.task.id);
    expect(task.status).not.toBe('failed');
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='failed'", say.task.id)).toHaveLength(0);
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='invocation.preempted'", say.task.id)).toHaveLength(1);
    const requested = f.store.all("SELECT data FROM events WHERE task_id=? AND type='preempt.requested'", say.task.id);
    expect(requested).toHaveLength(1);
    expect(JSON.parse(requested[0].data).reason).toBe('user message');
    // 这条输入没有被丢掉：下一轮调用读到它，任务照常静息。
    await until(() => f.project.running.size === 0, 8000);
    await until(() => f.store.task(say.task.id).status === 'waiting', 8000);
    expect(f.store.all('SELECT status FROM agent_runs ORDER BY id').map(run => run.status)).toEqual(['preempted', 'completed']);
    expect(f.store.all('SELECT consumed FROM messages WHERE task_id=?', say.task.id)).toEqual([{ consumed: 1 }]);
    expect(fs.existsSync(say.task.workspace)).toBe(true);
    expect(fs.existsSync(path.join(dir, `task-${say.task.id}.request.json`))).toBe(false);
  } finally { await f.close(); }
});

test('a restart clears stale preempt requests so a later invocation is never stopped by an expired one', async () => {
  const f = fixture(null, { LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: stub() });
  await repo(f.root);
  try {
    const dir = path.join(f.config.home, 'preempt');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'task-99.request.json'), JSON.stringify({ task_id: 99, run_id: 4, reason: 'user message' }));
    f.project.recover();
    expect(fs.existsSync(path.join(dir, 'task-99.request.json'))).toBe(false);
  } finally { await f.close(); }
});

test('backends without a verified safe boundary keep delivery at turn end and are not marked preempted', async () => {
  const proceed = gate();
  const f = fixture({ run: async () => { await proceed.promise; return 'finished anyway'; } });
  await repo(f.root);
  try {
    const say = await f.project.say('work on another backend');
    await until(() => f.project.running.has(say.task.id));
    expect(f.project.requestPreempt(say.task.id, 'user message')).toBe(false);
    f.project.message(say.task.id, 'note for later');
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='preempt.requested'", say.task.id)).toHaveLength(0);
    proceed.resolve();
    await until(() => !f.project.running.has(say.task.id));
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='invocation.preempted'", say.task.id)).toHaveLength(0);
    // 后端没有安全边界：不做主动收尾，但这条输入仍在轮末投递（会再跑一轮把它读掉）。
    expect(f.store.all('SELECT status FROM agent_runs ORDER BY id').every(run => run.status === 'completed')).toBe(true);
    await until(() => f.store.all('SELECT consumed FROM messages WHERE task_id=?', say.task.id)
      .every(row => row.consumed === 1));
  } finally { proceed.resolve(); await f.close(); }
});
