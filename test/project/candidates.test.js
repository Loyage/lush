import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, until, git, gate } from '../helpers.js';

function provider() {
  return { async run({ task, context }) {
    if (task.role === 'planner') return '计划完成';
    if (task.role === 'verifier' && context.verification?.candidate) {
      fs.mkdirSync(path.dirname(context.verification.report_path), { recursive: true });
      fs.writeFileSync(context.verification.report_path, '<!doctype html><title>candidate report</title><h1>ok</h1>');
      return '候选结果与基线对照完成，符合原始意图。';
    }
    return 'done';
  } };
}

test('review candidate freezes the intent commit, publishes evidence and lands only the reviewed tree', async () => {
  const f = fixture(provider()); await repo(f.root);
  try {
    const input = await f.project.submit('实现一个可以验收的结果');
    await until(() => f.store.task(input.task.id).status === 'completed');
    const file = path.join(input.anchor.workspace, 'result.txt');
    fs.writeFileSync(file, 'candidate result\n');
    await git(input.anchor.workspace, 'add', 'result.txt');
    await git(input.anchor.workspace, 'commit', '-m', 'candidate result');
    const reviewed = await git(input.anchor.workspace, 'rev-parse', 'HEAD');

    const prepared = await f.project.prepareCandidate(input.id, '可以验收的结果');
    expect(prepared).toMatchObject({ input_id: input.id, version: 1, status: 'pending', commit_hash: reviewed });
    expect(f.store.all("SELECT id FROM tasks WHERE role='verifier' AND review_candidate_id=?", prepared.id)).toEqual([]);

    // 冻结候选不会自动验收；只有用户显式请求才创建 verifier。
    const verifier = f.project.verifyCandidate(prepared.id);
    const graph = await f.project.graph();
    expect(graph.nodes.find(node => node.id === verifier.id)).toMatchObject({ role: 'verifier', branch: input.anchor.branch });
    await until(() => f.store.candidate(prepared.id).status === 'ready');
    const candidate = f.project.candidate(prepared.id);
    expect(candidate.has_report).toBe(true);
    expect(candidate.artifacts.some(artifact => artifact.kind === 'run.result')).toBe(true);

    const outcome = await f.project.acceptCandidate(candidate.id);
    expect(outcome.candidate.status).toBe('integrated');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(reviewed);
    expect(fs.readFileSync(path.join(f.root, 'result.txt'), 'utf8')).toBe('candidate result\n');
  } finally { await f.close(); }
});

test('candidate acceptance pins the reviewed commit inside the Git queue', async () => {
  const f = fixture(provider()); await repo(f.root);
  try {
    const input = await f.project.submit('交付固定候选提交');
    await until(() => f.store.task(input.task.id).status === 'completed');
    fs.writeFileSync(path.join(input.anchor.workspace, 'reviewed.txt'), 'reviewed\n');
    await git(input.anchor.workspace, 'add', 'reviewed.txt');
    await git(input.anchor.workspace, 'commit', '-m', 'reviewed candidate');
    const candidate = await f.project.prepareCandidate(input.id);
    f.store.updateCandidate(candidate.id, { status: 'ready' });

    // 抢先占住 Lush 的 Git 队列：accept 已记录用户决定、尚未进入实际 merge 时推进候选分支。
    const hold = gate();
    const blocker = f.project.workspaces.exclusive(() => hold.promise);
    const accepting = f.project.acceptCandidate(candidate.id);
    await until(() => f.store.candidate(candidate.id).status === 'accepted');
    fs.writeFileSync(path.join(input.anchor.workspace, 'unreviewed.txt'), 'must not land\n');
    await git(input.anchor.workspace, 'add', 'unreviewed.txt');
    await git(input.anchor.workspace, 'commit', '-m', 'unreviewed drift');
    const drifted = await git(input.anchor.workspace, 'rev-parse', 'HEAD');
    expect(drifted).not.toBe(candidate.commit_hash);
    hold.resolve(); await blocker;

    await expect(accepting).rejects.toThrow('moved from pinned commit');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(candidate.baseline_commit);
    expect(fs.existsSync(path.join(f.root, 'unreviewed.txt'))).toBe(false);
  } finally { await f.close(); }
});

test('candidate acceptance updates an unconnected parent ref to exactly the reviewed commit', async () => {
  const f = fixture(provider()); await repo(f.root);
  try {
    const input = await f.project.submit('交付到未检出的 main');
    await until(() => f.store.task(input.task.id).status === 'completed');
    fs.writeFileSync(path.join(input.anchor.workspace, 'pinned.txt'), 'pinned\n');
    await git(input.anchor.workspace, 'add', 'pinned.txt');
    await git(input.anchor.workspace, 'commit', '-m', 'pinned candidate');
    const candidate = await f.project.prepareCandidate(input.id);
    f.store.updateCandidate(candidate.id, { status: 'ready' });
    await git(f.root, 'checkout', '-b', 'parking');

    const accepted = await f.project.acceptCandidate(candidate.id);
    expect(accepted.candidate.status).toBe('integrated');
    expect(await git(f.root, 'branch', '--show-current')).toBe('parking');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(candidate.commit_hash);
    expect(await git(f.root, 'show', 'main:pinned.txt')).toBe('pinned');
  } finally { await f.close(); }
});

test('late candidate verification cannot overwrite superseded or explicit user states', async () => {
  const f = fixture(provider()); await repo(f.root);
  const report = task => {
    const file = f.project.reportPath(task.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '<!doctype html><title>late report</title>');
  };
  try {
    const input = await f.project.submit('验证候选状态竞争');
    await until(() => f.store.task(input.task.id).status === 'completed');
    fs.writeFileSync(path.join(input.anchor.workspace, 'result.txt'), 'candidate\n');
    await git(input.anchor.workspace, 'add', 'result.txt');
    await git(input.anchor.workspace, 'commit', '-m', 'candidate');
    f.project.stopping = true; // verifier 保持 queued，由测试确定性控制结算顺序。

    const first = await f.project.prepareCandidate(input.id);
    const firstVerifier = f.project.verifyCandidate(first.id);
    // 等价于新版本冻结时的 supersede 写入；保持旧 verifier 未结算以制造迟到顺序。
    f.store.updateCandidate(first.id, { status: 'superseded' });
    report(firstVerifier); f.project.finish(firstVerifier.id, 'completed', 'late');
    expect(f.store.candidate(first.id).status).toBe('superseded');

    const stale = await f.project.prepareCandidate(input.id);
    const staleVerifier = f.project.verifyCandidate(stale.id);
    f.store.updateCandidate(stale.id, { report_task_id: input.task.id });
    report(staleVerifier); f.project.finish(staleVerifier.id, 'completed', 'late');
    expect(f.store.candidate(stale.id).status).toBe('preparing');
    f.project.rejectCandidate(stale.id, '旧 verifier 已失效');

    const second = await f.project.prepareCandidate(input.id);
    const secondVerifier = f.project.verifyCandidate(second.id);
    f.project.rejectCandidate(second.id, '不接受这一版');
    report(secondVerifier); f.project.finish(secondVerifier.id, 'completed', 'late');
    expect(f.store.candidate(second.id).status).toBe('rejected');

    const third = await f.project.prepareCandidate(input.id);
    const thirdVerifier = f.project.verifyCandidate(third.id);
    f.project.requestCandidateChanges(third.id, '继续修改');
    report(thirdVerifier); f.project.finish(thirdVerifier.id, 'completed', 'late');
    expect(f.store.candidate(third.id).status).toBe('changes_requested');
  } finally { await f.close(); }
});

test('candidate acceptance rejects branch drift and feedback starts an incremental planner', async () => {
  const f = fixture(provider()); await repo(f.root);
  try {
    const input = await f.project.submit('做一个页面');
    await until(() => f.store.task(input.task.id).status === 'completed');
    fs.writeFileSync(path.join(input.anchor.workspace, 'page.txt'), 'v1\n');
    await git(input.anchor.workspace, 'add', 'page.txt'); await git(input.anchor.workspace, 'commit', '-m', 'v1');
    const prepared = await f.project.prepareCandidate(input.id);
    expect(prepared.status).toBe('pending');
    f.project.verifyCandidate(prepared.id);
    await until(() => f.store.candidate(prepared.id).status === 'ready');

    const revision = f.project.requestCandidateChanges(prepared.id, '按钮需要更明显');
    expect(revision.candidate.status).toBe('changes_requested');
    expect(revision.planner.role).toBe('planner');
    expect(f.store.get('SELECT task_id FROM inputs WHERE id=?', input.id).task_id).toBe(revision.planner.id);
    await until(() => f.store.task(revision.planner.id).status === 'completed');
  } finally { await f.close(); }
});
