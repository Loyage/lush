import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, gate, git, repo, until } from '../helpers.js';
import { apForest } from '../../src/ui/web/assets/ap-graph-layout.js';
import { snapshotPath } from '../../src/core/ap-input-rule.js';

const rule = `const data = await Bun.stdin.json();
console.log(JSON.stringify({ delivery: data.input.startsWith('later:') ? 'message' : 'interrupt' }));\n`;

test('AP graph keeps owner, child and old aps with branches as attributes', async () => {
  const f = fixture({ run: async () => 'done' }); await repo(f.root);
  try {
    const input = await f.project.say('work');
    const graph = await f.project.apGraph();
    const say = graph.nodes.find(node => node.id === input.ap.id);
    const main = graph.nodes.find(node => node.ap_kind === 'main');
    expect(say.parent_id).toBe(main.id);
    expect(say.branch).toBe(input.ap.branch);
    expect(say.workspace).toBe(input.ap.workspace);
    expect(graph.edges).toContainEqual({ from: main.id, to: say.id });
    expect(graph.nodes.every(node => node.kind === 'ap')).toBe(true);
    expect(apForest(graph)[0].children[0].id).toBe(say.id);
  } finally { await f.close(); }
});

test('AP graph projects current Git diagnostics, compact progress, waiting and open decisions without writing facts', async () => {
  const hold = gate();
  const f = fixture({ run: async () => { await hold.promise; return 'done'; } }); await repo(f.root);
  try {
    const created = await f.project.say('实施功能\n验收条件');
    await until(() => f.store.all("SELECT id FROM events WHERE ap_id=? AND type='invocation.started'", created.ap.id).length > 0);
    f.store.setProgressPlan(created.ap.id, { version: 1, items: [
      { key: 'inspect', label: '现状', status: 'completed' },
      { key: 'build', label: '实现', status: 'pending', started_at: new Date().toISOString() },
    ] });
    const notice = f.project.notice(created.ap.id, '决定方案', '请先确认');
    fs.writeFileSync(path.join(created.ap.workspace, 'file.txt'), 'base\nnew\n');
    const before = f.store.all('SELECT count(*) AS n FROM events')[0].n;
    const graph = await f.project.apGraph();
    const node = graph.nodes.find(item => item.id === created.ap.id);
    expect(node.goal_preview).toContain('验收条件');
    expect(node.progress).toMatchObject({ total: 2, completed: 1, current: { label: '实现' } });
    expect(node.notice).toMatchObject({ id: notice.id, title: '决定方案' });
    expect(node.notice_count).toBe(1);
    expect(node.branch_info.diagnostics.working_tree.status).toBe('dirty');
    expect(node.branch_info.diagnostics.working_tree.files_total).toBe(1);
    expect(node.branch_info.diagnostics.changes.status).toBe('ok');
    expect(f.store.all('SELECT count(*) AS n FROM events')[0].n).toBe(before);
  } finally { hold.resolve(); await f.close(); }
});

test('AP graph projects branch-level merge orchestration state read-only', async () => {
  const f = fixture({ run: async () => 'done' }); await repo(f.root);
  try {
    const input = await f.project.say('work');
    const graph = await f.project.apGraph();
    const main = graph.nodes.find(node => node.ap_kind === 'main');
    const say = graph.nodes.find(node => node.id === input.ap.id);
    // 主 AP 的分支下挂着 1 条 say 子分支；say 自己没有子分支，不冒充有。
    expect(main.branch_info.subtree_say).toBe(1);
    expect(say.branch_info.subtree_say).toBe(0);
    // 没有活动编排运行时不编造一个。
    expect(main.branch_info.merge_run).toBeNull();

    const before = f.store.all('SELECT count(*) AS n FROM events')[0].n;
    if (!f.store.branch('main')) f.store.recordBranch({ branch: 'main' });
    f.store.setBranchMergeRun('main', { version: 1, mode: 'orchestrate', ap_id: 99, status: 'paused',
      order: ['a', 'b'], done: ['a'] });
    const after = (await f.project.apGraph()).nodes.find(node => node.ap_kind === 'main');
    expect(after.branch_info.merge_run).toEqual({ mode: 'orchestrate', status: 'paused', done: 1, total: 2, ap_id: 99 });
    // 读面只投影，不写事件、不改运行态。
    expect(f.store.all('SELECT count(*) AS n FROM events')[0].n).toBe(before);
    expect(f.store.branchMergeRun('main')).toMatchObject({ status: 'paused', ap_id: 99 });
  } finally { await f.close(); }
});

test('AP input rule is frozen from committed fork, chooses delivery, and falls back without losing input', async () => {
  const paused = gate();
  const f = fixture({ run: async () => { await paused.promise; return 'done'; } }); await repo(f.root);
  try {
    fs.mkdirSync(path.join(f.root, '.lush-ap'));
    fs.writeFileSync(path.join(f.root, '.lush-ap/input.mjs'), rule);
    await git(f.root, 'add', '.lush-ap/input.mjs'); await git(f.root, 'commit', '-m', 'input rule');
    const say = await f.project.say('work');
    await until(() => f.project.running.has(say.ap.id));
    expect(fs.readFileSync(snapshotPath(f.config.home, say.ap.id), 'utf8').trim()).toBe(rule.trim());
    expect((await f.project.apGraph()).nodes.find(node => node.id === say.ap.id).has_rule).toBe(true);
    const child = f.project.spawn(say.ap.id, 'child');
    expect(fs.readFileSync(snapshotPath(f.config.home, child.id), 'utf8').trim()).toBe(rule.trim());
    // Changing the worktree after creation does not change the fixed rule.
    fs.writeFileSync(path.join(say.ap.workspace, '.lush-ap/input.mjs'), 'console.log(JSON.stringify({delivery:"interrupt"}))');
    f.project.message(say.ap.id, 'later: wait');
    expect(f.store.all("SELECT id FROM events WHERE ap_id=? AND type='preempt.requested'", say.ap.id)).toHaveLength(0);
    f.project.message(say.ap.id, 'urgent');
    expect(f.store.all("SELECT data FROM events WHERE ap_id=? AND type='ap.input_routed'", say.ap.id)
      .map(row => JSON.parse(row.data).delivery)).toEqual(['message', 'interrupt']);
    // A broken rule cannot silently drop an input; failure and fallback are auditable.
    fs.writeFileSync(snapshotPath(f.config.home, say.ap.id), 'process.exit(7)');
    f.project.message(say.ap.id, 'still deliver');
    expect(f.store.unread(say.ap.id).map(item => item.body)).toContain('still deliver');
    expect(JSON.parse(f.store.all("SELECT data FROM events WHERE ap_id=? AND type='ap.input_routed' ORDER BY id DESC LIMIT 1", say.ap.id)[0].data))
      .toMatchObject({ delivery: 'interrupt', source: 'fallback' });
  } finally { paused.resolve(); await f.close(); }
});

test('AP forest shows truncated parents and tolerates corrupt cycles', () => {
  expect(apForest({ nodes: [{ id: 2, parent_id: 1 }, { id: 3, parent_id: 2 }] })[0].children[0].id).toBe(3);
  expect(apForest({ nodes: [{ id: 1, parent_id: 2 }, { id: 2, parent_id: 1 }] })).toHaveLength(2);
});
