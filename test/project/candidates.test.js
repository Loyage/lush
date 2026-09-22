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
      fs.writeFileSync(context.verification.evidence_path, JSON.stringify({ schema_version: 1, status: 'pass',
        summary: '候选结果与基线对照完成，符合原始意图。',
        commands: [{ command: 'bun run test', exit_code: 0, baseline_exit_code: 0, summary: '两边命令均正常完成' }],
        failures: [], unverified: [], baseline_failures: [], residual_risks: [] }));
      return '候选结果与基线对照完成，符合原始意图。';
    }
    return 'done';
  } };
}

/** Candidate-focused fixture: freeze one commit without scheduling a verifier. */
async function frozenCandidate(f, target = null) {
  const input = await f.project.submit('交付固定候选提交', target);
  await until(() => f.store.task(input.task.id).status === 'completed');
  fs.writeFileSync(path.join(input.anchor.workspace, 'reviewed.txt'), 'reviewed\n');
  await git(input.anchor.workspace, 'add', 'reviewed.txt');
  await git(input.anchor.workspace, 'commit', '-m', 'reviewed candidate');
  const reviewed = await git(input.anchor.workspace, 'rev-parse', 'HEAD');
  const candidate = await f.project.prepareCandidate(input.id, '固定候选提交');
  return { input, candidate, reviewed };
}

/** Acceptance-focused fixture: settle an already-tested review through the Candidate state contract. */
function markCandidateReady(f, candidate) {
  const reportTask = f.store.get('SELECT task_id FROM inputs WHERE id=?', candidate.input_id).task_id;
  f.store.transitionCandidate(candidate.id, 'verification_requested', { report_task_id: reportTask });
  f.store.settleCandidateVerification(candidate.id, reportTask, 'ready');
  return f.store.candidate(candidate.id);
}
async function readyCandidate(f, target = null) {
  const frozen = await frozenCandidate(f, target);
  return { ...frozen, candidate: markCandidateReady(f, frozen.candidate) };
}

function writeReport(f, taskId) {
  const file = f.project.reportPath(taskId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '<!doctype html><title>late candidate report</title><h1>ok</h1>');
}

function writePassingArtifact(f, taskId) {
  const task = f.store.task(taskId);
  const candidate = f.store.candidate(task.review_candidate_id);
  f.store.addArtifact({ task_id: task.id, input_id: task.input_id, kind: 'run.result', payload: {
    schema_version: 2, invocation: { status: 'completed' }, outcome: 'success', summary: 'verified',
    verification: { status: 'pass', tested_commit: candidate.commit_hash, baseline_commit: candidate.baseline_commit,
      commands: [{ command: 'bun run test', exit_code: 0, baseline_exit_code: 0, summary: 'passed' }],
      summary: 'passed', report: { task_id: task.id, path: f.project.reportPath(task.id), available: true },
      failures: [], unverified: [], baseline_failures: [], residual_risks: [] },
  } });
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
    expect(candidate.verification).toMatchObject({ status: 'pass', tested_commit: reviewed,
      baseline_commit: prepared.baseline_commit });
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
    const candidate = markCandidateReady(f, await f.project.prepareCandidate(input.id));

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

    const accepted = await accepting;
    expect(accepted.candidate.status).toBe('integrated');
    expect(accepted.integration.landed).toBe(candidate.commit_hash);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(candidate.commit_hash);
    expect(fs.readFileSync(path.join(f.root, 'reviewed.txt'), 'utf8')).toBe('reviewed\n');
    expect(fs.existsSync(path.join(f.root, 'unreviewed.txt'))).toBe(false);
  } finally { await f.close(); }
});

test('accepted candidate rejects concurrent rejection, feedback and replacement until Git settles', async () => {
  const f = fixture(provider()); await repo(f.root);
  const hold = gate();
  let blocker = null;
  let accepting = null;
  try {
    const { input, candidate, reviewed } = await readyCandidate(f);
    blocker = f.project.workspaces.exclusive(() => hold.promise);
    accepting = f.project.acceptCandidate(candidate.id);
    await until(() => f.store.candidate(candidate.id).status === 'accepted');
    const plannerCount = f.store.get("SELECT count(*) AS value FROM tasks WHERE input_id=? AND role='planner'", input.id).value;

    await expect(f.project.acceptCandidate(candidate.id)).rejects.toThrow('only a ready candidate can start acceptance');
    expect(() => f.project.rejectCandidate(candidate.id, 'too late')).toThrow(/accepted candidate cannot be rejected/);
    expect(() => f.project.requestCandidateChanges(candidate.id, 'too late')).toThrow(/accepted candidate cannot be changed/);
    await expect(f.project.prepareCandidate(input.id, 'too late')).rejects.toThrow('cannot supersede');
    expect(() => f.store.updateCandidate(candidate.id, { status: 'ready' }))
      .toThrow('only an integration outcome can change its status');
    expect(() => f.store.createCandidate({ input_id: candidate.input_id, branch: candidate.branch,
      commit: candidate.commit_hash, baseline_branch: candidate.baseline_branch,
      baseline_commit: candidate.baseline_commit, summary: 'bypass prepare' }))
      .toThrow('cannot prepare a replacement until Git settles');
    expect(f.store.candidates(input.id)).toHaveLength(1);
    expect(f.store.get("SELECT count(*) AS value FROM tasks WHERE input_id=? AND role='planner'", input.id).value)
      .toBe(plannerCount);
    expect(f.store.candidate(candidate.id).status).toBe('accepted');

    hold.resolve(); await blocker;
    const outcome = await accepting;
    expect(outcome.candidate.status).toBe('integrated');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(reviewed);
    expect(f.store.candidate(candidate.id).status).toBe('integrated');
  } finally {
    hold.resolve();
    if (blocker) await blocker.catch(() => {});
    if (accepting) await accepting.catch(() => {});
    await f.close();
  }
});

test('candidate acceptance updates an unconnected parent ref to exactly the reviewed commit', async () => {
  const f = fixture(provider()); await repo(f.root);
  try {
    const input = await f.project.submit('交付到未检出的 main');
    await until(() => f.store.task(input.task.id).status === 'completed');
    fs.writeFileSync(path.join(input.anchor.workspace, 'pinned.txt'), 'pinned\n');
    await git(input.anchor.workspace, 'add', 'pinned.txt');
    await git(input.anchor.workspace, 'commit', '-m', 'pinned candidate');
    const candidate = markCandidateReady(f, await f.project.prepareCandidate(input.id));
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

test('candidate acceptance rejects drift that happened before its tip validation', async () => {
  const f = fixture(provider()); await repo(f.root);
  try {
    const { input, candidate, reviewed } = await readyCandidate(f);
    fs.writeFileSync(path.join(input.anchor.workspace, 'unreviewed.txt'), 'unreviewed\n');
    await git(input.anchor.workspace, 'add', 'unreviewed.txt');
    await git(input.anchor.workspace, 'commit', '-m', 'advance after review');

    await expect(f.project.acceptCandidate(candidate.id)).rejects.toThrow(/moved to .*prepare a new candidate/);
    expect(await git(f.root, 'rev-parse', 'main')).not.toBe(reviewed);
    expect(f.store.candidate(candidate.id).status).toBe('ready');
    expect(fs.existsSync(path.join(f.root, 'unreviewed.txt'))).toBe(false);
  } finally { await f.close(); }
});

test('candidate acceptance lands the pinned commit when its branch advances after validation', async () => {
  const f = fixture(provider()); await repo(f.root);
  try {
    const { input, candidate, reviewed } = await readyCandidate(f);
    const workspaces = f.project.workspaces;
    const mergeBranchUnsafe = workspaces.mergeBranchUnsafe.bind(workspaces);
    let injected = false;
    let expected = null;
    // Deterministic interleave: mergeBranch has acquired the Git queue, but has not read branchState yet.
    workspaces.mergeBranchUnsafe = async (branch, pinned) => {
      expected = pinned;
      if (!injected) {
        injected = true;
        fs.writeFileSync(path.join(input.anchor.workspace, 'unreviewed.txt'), 'unreviewed\n');
        await git(input.anchor.workspace, 'add', 'unreviewed.txt');
        await git(input.anchor.workspace, 'commit', '-m', 'advance inside merge queue');
      }
      return mergeBranchUnsafe(branch, pinned);
    };

    const outcome = await f.project.acceptCandidate(candidate.id);
    expect(injected).toBe(true);
    expect(expected).toBe(reviewed);
    expect(outcome.candidate.status).toBe('integrated');
    expect(outcome.integration.landed).toBe(reviewed);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(reviewed);
    expect(fs.readFileSync(path.join(f.root, 'reviewed.txt'), 'utf8')).toBe('reviewed\n');
    expect(fs.existsSync(path.join(f.root, 'unreviewed.txt'))).toBe(false);
    expect(await git(input.anchor.workspace, 'rev-parse', 'HEAD')).not.toBe(reviewed);
    const history = f.store.history(input.task.id);
    expect(history.find(row => row.type === 'branch.merged')?.data.commit).toBe(reviewed);
    expect(history.find(row => row.type === 'candidate.integrated')?.data.commit).toBe(reviewed);
  } finally { await f.close(); }
});

test('candidate acceptance updates an unchecked parent ref to exactly the pinned commit', async () => {
  const f = fixture(provider()); await repo(f.root);
  try {
    // main remains a local ref but is not checked out in any worktree, so landing uses update-ref CAS.
    await git(f.root, 'checkout', '-b', 'parked');
    const { input, candidate, reviewed } = await readyCandidate(f, 'main');
    const workspaces = f.project.workspaces;
    const mergeBranchUnsafe = workspaces.mergeBranchUnsafe.bind(workspaces);
    workspaces.mergeBranchUnsafe = async (branch, pinned) => {
      fs.writeFileSync(path.join(input.anchor.workspace, 'unreviewed.txt'), 'unreviewed\n');
      await git(input.anchor.workspace, 'add', 'unreviewed.txt');
      await git(input.anchor.workspace, 'commit', '-m', 'advance before update-ref');
      return mergeBranchUnsafe(branch, pinned);
    };

    const outcome = await f.project.acceptCandidate(candidate.id);
    expect(outcome.candidate.status).toBe('integrated');
    expect(outcome.integration.landed).toBe(reviewed);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(reviewed);
    expect(await git(input.anchor.workspace, 'rev-parse', 'HEAD')).not.toBe(reviewed);
    await expect(git(f.root, 'show', 'main:unreviewed.txt')).rejects.toThrow();
    expect(await git(f.root, 'symbolic-ref', '--short', 'HEAD')).toBe('parked');
    expect(fs.existsSync(path.join(f.root, 'reviewed.txt'))).toBe(false);
  } finally { await f.close(); }
});

test('candidate acceptance treats the pinned commit already in the parent as integrated', async () => {
  const f = fixture(provider()); await repo(f.root);
  try {
    const { candidate, reviewed } = await readyCandidate(f);
    await git(f.root, 'merge', '--ff-only', reviewed);

    const outcome = await f.project.acceptCandidate(candidate.id);
    expect(outcome.candidate.status).toBe('integrated');
    expect(outcome.integration).toMatchObject({ merged: false, already_integrated: true, landed: reviewed });
    expect(await git(f.root, 'rev-parse', 'main')).toBe(reviewed);
  } finally { await f.close(); }
});

test('candidate acceptance failure returns to ready and records the merge error', async () => {
  const f = fixture(provider()); await repo(f.root);
  try {
    const { input, candidate } = await readyCandidate(f);
    fs.writeFileSync(path.join(f.root, 'dirty.txt'), 'dirty\n');

    await expect(f.project.acceptCandidate(candidate.id)).rejects.toThrow('working tree is dirty');
    expect(f.store.candidate(candidate.id).status).toBe('ready');
    const event = f.store.history(input.task.id).find(row => row.type === 'candidate.accept_failed');
    expect(event?.data).toMatchObject({ candidate: candidate.id, target: 'main' });
    expect(event?.data.error).toContain('working tree is dirty');
  } finally { await f.close(); }
});

test('late successful and failed verifiers cannot revive a rejected candidate', async () => {
  for (const terminal of ['completed', 'failed']) {
    const f = fixture(provider()); await repo(f.root);
    try {
      const { candidate } = await frozenCandidate(f);
      f.project.stopping = true;
      const verifier = f.project.verifyCandidate(candidate.id);
      const rejected = f.project.rejectCandidate(candidate.id, `reject before ${terminal}`);
      if (terminal === 'completed') writeReport(f, verifier.id);

      f.project.finish(verifier.id, terminal, terminal === 'completed' ? 'late success' : null,
        terminal === 'failed' ? 'late failure' : null);
      expect(f.store.candidate(candidate.id)).toMatchObject({ status: 'rejected',
        report_task_id: verifier.id, feedback: rejected.feedback });
      expect(f.store.task(verifier.id)).toMatchObject({ status: terminal,
        result: terminal === 'completed' ? 'late success' : null });
      const events = f.store.history(verifier.id);
      expect(events.some(row => row.type === 'candidate.verified')).toBe(false);
      expect(events.find(row => row.type === 'candidate.verification_ignored')?.data)
        .toMatchObject({ candidate: candidate.id, status: terminal, candidate_status: 'rejected',
          current_report_task_id: verifier.id, has_report: terminal === 'completed' });
    } finally { await f.close(); }
  }
});

test('late verifier result cannot overwrite changes_requested', async () => {
  const f = fixture(provider()); await repo(f.root);
  try {
    const { candidate } = await frozenCandidate(f);
    f.project.stopping = true;
    const verifier = f.project.verifyCandidate(candidate.id);
    const revision = f.project.requestCandidateChanges(candidate.id, '用户已经要求修改');
    writeReport(f, verifier.id);

    f.project.finish(verifier.id, 'completed', 'obsolete review');
    expect(f.store.candidate(candidate.id)).toMatchObject({ status: 'changes_requested',
      report_task_id: verifier.id, feedback: '用户已经要求修改' });
    expect(f.store.task(revision.planner.id).role).toBe('planner');
    expect(f.store.history(verifier.id).find(row => row.type === 'candidate.verification_ignored')?.data)
      .toMatchObject({ candidate_status: 'changes_requested', current_report_task_id: verifier.id });
  } finally { await f.close(); }
});

test('late verifier result cannot overwrite a superseded candidate', async () => {
  const f = fixture(provider()); await repo(f.root);
  try {
    const { candidate } = await frozenCandidate(f);
    f.project.stopping = true;
    const verifier = f.project.verifyCandidate(candidate.id);
    // Simulate the replacement transaction directly so callback authority is independent of branch blockers.
    const replacement = f.store.transaction(() => {
      f.store.updateCandidate(candidate.id, { status: 'superseded' });
      return f.store.createCandidate({ input_id: candidate.input_id, branch: candidate.branch,
        commit: candidate.commit_hash, baseline_branch: candidate.baseline_branch,
        baseline_commit: candidate.baseline_commit, summary: '替代版本' });
    });
    writeReport(f, verifier.id);

    f.project.finish(verifier.id, 'completed', 'obsolete review');
    expect(f.store.candidate(candidate.id)).toMatchObject({ status: 'superseded', report_task_id: verifier.id });
    expect(f.store.candidate(replacement.id).status).toBe('pending');
    expect(f.store.history(verifier.id).find(row => row.type === 'candidate.verification_ignored')?.data)
      .toMatchObject({ candidate_status: 'superseded', current_report_task_id: verifier.id });
  } finally { await f.close(); }
});

test('only the currently registered verifier can settle a preparing candidate', async () => {
  const f = fixture(provider()); await repo(f.root);
  try {
    const { candidate } = await frozenCandidate(f);
    f.project.stopping = true;
    const obsolete = f.project.verifyCandidate(candidate.id);
    const current = f.store.create({ parent_id: null, input_id: candidate.input_id, role: 'verifier',
      goal: 'current candidate verification', name: `candidate-${candidate.id}-current`, review_candidate_id: candidate.id });
    f.store.updateCandidate(candidate.id, { status: 'preparing', report_task_id: current.id });
    writeReport(f, obsolete.id);

    f.project.finish(obsolete.id, 'completed', 'obsolete result');
    expect(f.store.candidate(candidate.id)).toMatchObject({ status: 'preparing', report_task_id: current.id });
    expect(f.store.history(obsolete.id).find(row => row.type === 'candidate.verification_ignored')?.data)
      .toMatchObject({ candidate_status: 'preparing', current_report_task_id: current.id });

    writeReport(f, current.id);
    writePassingArtifact(f, current.id);
    f.project.finish(current.id, 'completed', 'current result');
    expect(f.store.candidate(candidate.id)).toMatchObject({ status: 'ready', report_task_id: current.id });
    expect(f.store.history(current.id).find(row => row.type === 'candidate.verified')?.data)
      .toMatchObject({ candidate_status: 'ready', has_report: true });
  } finally { await f.close(); }
});

test('the current verifier still marks the candidate failed when its evidence is incomplete', async () => {
  const f = fixture(provider()); await repo(f.root);
  try {
    const { candidate } = await frozenCandidate(f);
    f.project.stopping = true;
    const verifier = f.project.verifyCandidate(candidate.id);

    f.project.finish(verifier.id, 'completed', 'no report produced');
    expect(f.store.candidate(candidate.id)).toMatchObject({ status: 'failed', report_task_id: verifier.id });
    expect(f.store.history(verifier.id).find(row => row.type === 'candidate.verified')?.data)
      .toMatchObject({ candidate_status: 'failed', has_report: false });
  } finally { await f.close(); }
});
