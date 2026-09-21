import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../src/config.js';
import { Store } from '../src/persistence/store.js';
import { temp, env, fixture } from './helpers.js';
import { setup, change } from './workspaces/harness.js';

// 分支的一句话摘要：store 的读写与校验、加列式 schema 演进，以及 graph 读模型里
// 「title 优先用摘要、没有摘要才回落派生」的契约。多带一个字段，不改任何既有字段的语义。

test('store 的分支摘要经 branch() / branches() 原样带出', async () => {
  const f = fixture();
  try {
    f.store.recordBranch({ branch: 'lush/x/one', parent: 'main' });
    f.store.recordBranch({ branch: 'lush/x/two', parent: 'main' });
    // 没写过摘要就不是空串：字段在、值为 null，不假装有标题。
    expect(f.store.branch('lush/x/one').summary).toBeNull();

    const updated = f.store.setBranchSummary('lush/x/one', '  把分支图标题改成  一句话摘要  ');
    // 去首尾空白、内部连续空白压成单空格。
    expect(updated.summary).toBe('把分支图标题改成 一句话摘要');
    expect(f.store.branch('lush/x/one').summary).toBe('把分支图标题改成 一句话摘要');

    const rows = f.store.branches();
    expect(rows.find(row => row.branch === 'lush/x/one').summary).toBe('把分支图标题改成 一句话摘要');
    expect(rows.find(row => row.branch === 'lush/x/two').summary).toBeNull();
  } finally { await f.close(); }
});

test('setBranchSummary 拒绝空 / 超长摘要与未登记分支', async () => {
  const f = fixture();
  try {
    f.store.recordBranch({ branch: 'lush/x/one' });
    for (const bad of ['', '   ', '\n\t']) expect(() => f.store.setBranchSummary('lush/x/one', bad)).toThrow();
    expect(() => f.store.setBranchSummary('lush/x/one', '标'.repeat(121))).toThrow();
    expect(() => f.store.setBranchSummary('lush/x/missing', '还没登记的分支')).toThrow();
    // 拒绝的写法一个都不该落库。
    expect(f.store.branch('lush/x/one').summary).toBeNull();
    // 120 字是允许的边界。
    expect(f.store.setBranchSummary('lush/x/one', '标'.repeat(120)).summary).toHaveLength(120);
  } finally { await f.close(); }
});

test('setBranchSummary 只改 summary 一列，不动 status / deleted_at', async () => {
  const f = fixture();
  try {
    f.store.recordBranch({ branch: 'lush/x/one', parent: 'main', created_from_commit: 'aaa', worktree: '/tmp/wt' });
    f.store.markBranchArchived('lush/x/one');
    const before = f.store.branch('lush/x/one');
    f.store.setBranchSummary('lush/x/one', '归档分支也有摘要');
    const after = f.store.branch('lush/x/one');
    expect(after.summary).toBe('归档分支也有摘要');
    expect(after.status).toBe('archived');
    expect(after.deleted_at).toBe(before.deleted_at);
    expect(after.worktree).toBe(before.worktree);
    expect(after.parent).toBe(before.parent);
  } finally { await f.close(); }
});

test('老库（branches 表还没有 summary 列）打开后自动补列', () => {
  const root = temp();
  const config = new Config({ project: root, env: env() });
  config.prepare();
  const file = path.join(config.home, 'project.db');
  const first = new Store(file, root);
  // 模拟后来才加列之前建的库：把 summary 列删掉。
  first.run('ALTER TABLE branches DROP COLUMN summary');
  expect(first.all('PRAGMA table_info(branches)').map(row => row.name)).not.toContain('summary');
  first.close();

  const reopened = new Store(file, root);
  try {
    expect(reopened.all('PRAGMA table_info(branches)').map(row => row.name)).toContain('summary');
    reopened.recordBranch({ branch: 'lush/x/legacy' });
    expect(reopened.setBranchSummary('lush/x/legacy', '老库补列之后也能写摘要').summary).toBe('老库补列之后也能写摘要');
  } finally {
    reopened.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('graph：分支有摘要时标题就是摘要，不再显示输入原文首行', async () => {
  const f = await setup();
  try {
    const inputId = f.store.nextInputId();
    f.store.run('INSERT INTO inputs(id,content,anchor_branch) VALUES (?,?,?)',
      inputId, '用户输入的原文首行\n第二行同样不该出现', 'lush/test/input-1-anchor');
    f.store.recordBranch({ branch: 'lush/test/input-1-anchor', parent: 'main' });
    f.store.setBranchSummary('lush/test/input-1-anchor', '把分支图标题换成一句话摘要');

    const graph = await f.project.graph();
    const node = graph.nodes.find(candidate => candidate.id === 'branch:lush/test/input-1-anchor');
    expect(node).toMatchObject({
      origin: 'input', summary: '把分支图标题换成一句话摘要',
      title: '把分支图标题换成一句话摘要', source_id: inputId,
    });
    expect(node.title).not.toContain('用户输入的原文首行');
  } finally { await f.close(); }
});

test('graph：摘要缺失或为空白时完整回落到既有派生标题', async () => {
  const f = await setup();
  try {
    const inputId = f.store.nextInputId();
    f.store.run('INSERT INTO inputs(id,content,anchor_branch) VALUES (?,?,?)',
      inputId, '  用户输入第一行  \n忽略我', 'lush/test/input-1-anchor');
    f.store.recordBranch({ branch: 'lush/test/input-1-anchor', parent: 'main' });
    await change(f, f.task, 'A\n');
    const worker = f.store.task(f.task.id);
    // 绕过 setter 直接写一段空白：读模型要把它当成「没有摘要」。
    f.store.run('UPDATE branches SET summary=? WHERE branch=?', '   ', 'lush/test/input-1-anchor');

    const graph = await f.project.graph();
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    expect(nodes.get('branch:lush/test/input-1-anchor')).toMatchObject({ summary: null, title: '用户输入第一行' });
    expect(nodes.get(`branch:${worker.branch}`)).toMatchObject({ summary: null, title: 'implement' });
  } finally { await f.close(); }
});

test('graph：写摘要不改动分支节点的任何其他字段', async () => {
  const f = await setup();
  try {
    f.store.recordBranch({ branch: 'lush/test/stable', parent: 'main' });
    const before = (await f.project.graph()).nodes.find(node => node.id === 'branch:lush/test/stable');
    f.store.setBranchSummary('lush/test/stable', '只改标题');
    const after = (await f.project.graph()).nodes.find(node => node.id === 'branch:lush/test/stable');

    const { title: beforeTitle, summary: beforeSummary, ...restBefore } = before;
    const { title: afterTitle, summary: afterSummary, ...restAfter } = after;
    expect(beforeTitle).toBeNull(); expect(beforeSummary).toBeNull();
    expect(afterTitle).toBe('只改标题'); expect(afterSummary).toBe('只改标题');
    expect(restAfter).toEqual(restBefore);
  } finally { await f.close(); }
});
