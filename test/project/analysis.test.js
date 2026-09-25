import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { assertAllowed } from '../../src/rpc/registry.js';
import { agentPrompt } from '../../src/agent/prompts.js';

test('on-demand analysis runs in a detached checkout with no branch and no delivery record', async () => {
  const seen = {};
  const proceed = gate();
  const f = fixture({ run: async ({ task, cwd }) => { seen.task = task; seen.cwd = cwd; await proceed.promise; return '结论：风险集中在解锁逻辑。'; } });
  await repo(f.root);
  try {
    const main = await f.project.ensureMainTask();
    const tip = await git(f.root, 'rev-parse', 'main');
    const before = await git(f.root, 'branch', '--list', '--format=%(refname:short)');
    expect(() => assertAllowed('task.analyze', { id: main.id, question: 'x' }, main.id)).toThrow('requires user approval');
    const created = await new Dispatcher(f.project).dispatch('task.analyze', { id: main.id, question: '现在最大的回归风险是什么？' });
    expect(created).toMatchObject({ status: 'queued', branch: 'main', commit: tip });
    const task = f.store.task(created.task.id);
    expect(task).toMatchObject({ task_kind: 'analysis', parent_id: main.id, role: 'agent', goal: '现在最大的回归风险是什么？',
      target_branch: 'main', base_commit: tip, branch: null, input_id: null, integration: 'none' });
    // 分析工作区：分离检出、正好停在这条分支的顶端，而且没有新增任何分支 ref。
    await until(() => seen.cwd);
    expect(seen.task.task_kind).toBe('analysis');
    expect(seen.cwd).not.toBe(f.root);
    expect(await git(f.root, 'branch', '--list', '--format=%(refname:short)')).toBe(before);
    expect(await git(seen.cwd, 'branch', '--show-current')).toBe('');
    expect(await git(seen.cwd, 'rev-parse', 'HEAD')).toBe(tip);
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='analysis.checkout'", task.id)).toHaveLength(1);
    // 只读分析 Task 不能派工：机制上只留“提问→回答”。
    expect(() => f.project.spawn(task.id, 'follow-up work', 'agent')).toThrow('do not delegate');
    proceed.resolve();
    await until(() => f.store.task(task.id).status === 'completed');
    // 答案成为 result；没有 head_commit / integration，也不会有待合并改动。
    const done = f.store.task(task.id);
    expect(done.result).toContain('风险集中在解锁逻辑');
    expect(done.head_commit).toBeNull();
    expect(done.integration).toBe('none'); // 只读分析不产生可交付改动
    // 派生检出在 invocation 结束时回收（异步收尾，等它落地再断言）。
    await until(() => f.store.task(task.id).baseline_workspace === null);
    await until(() => !fs.existsSync(seen.cwd));
    const notices = f.store.all("SELECT * FROM notices WHERE task_id=? AND kind='info'", task.id);
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toBe(`分支 main 的分析 #${task.id} 已完成`);
    expect(notices[0]).toMatchObject({ kind: 'info', status: 'sent' });
    expect(notices[0].body).toContain('风险集中在解锁逻辑');
    // 只读分析不给 main 收件箱塞一条它永远不会处理的消息：提醒（notice）才是给用户看的。
    expect(f.store.all('SELECT id FROM messages WHERE task_id=?', main.id)).toHaveLength(0);
    // 清理这条只读任务不需要按“未合并”门槛拦：它没有分支可留。
    const cleanup = await f.project.workspaces.cleanup(task.id);
    expect(cleanup.cleanup).toMatchObject({ worktree: 'absent', branch: 'absent' });
  } finally { proceed.resolve(); await f.close(); }
});

test('analysis is refused for non-owner Tasks and keeps the frozen tip per invocation', async () => {
  const f = fixture();
  await repo(f.root);
  try {
    const main = await f.project.ensureMainTask();
    const say = await f.project.say('develop something');
    await expect(f.project.analyze(say.task.id, 'question')).rejects.toThrow('only a branch owner Task');
    await expect(f.project.analyze(main.id, '')).rejects.toThrow();
    await expect(f.project.analyze(main.id, 'x'.repeat(4001))).rejects.toThrow('4000 characters');
    // 用户提交新的分析：冻结的是提交那一刻的分支顶端，与之后 main 是否前进无关。
    const tip = await git(f.root, 'rev-parse', 'main');
    const first = await f.project.analyze(main.id, '第一次提问');
    expect(first.commit).toBe(tip);
    await git(f.root, 'commit', '--allow-empty', '-m', 'main moved');
    const second = await f.project.analyze(main.id, '第二次提问');
    expect(second.commit).not.toBe(tip);
    expect(second.commit).toBe(await git(f.root, 'rev-parse', 'main'));
  } finally { await f.close(); }
});

test('the analysis prompt is read-only: no branch, no delegation, no merge claim', () => {
  const config = { project: '/tmp/project', home: '/tmp/home' };
  const analysis = agentPrompt(config, 'agent', {}, 'analysis').text;
  expect(analysis).toContain('只读分支分析');
  expect(analysis).toContain('不要创建、切换、删除或推送分支');
  expect(analysis).toContain('不派子任务');
  expect(analysis).not.toContain('你可以使用 lush task spawn');
  expect(agentPrompt(config, 'agent', {}).text).toContain('你可以使用 lush task spawn');
});
