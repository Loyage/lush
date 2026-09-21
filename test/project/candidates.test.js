import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, until, git } from '../helpers.js';

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
    expect(prepared).toMatchObject({ input_id: input.id, version: 1, status: 'preparing', commit_hash: reviewed });
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

test('candidate acceptance rejects branch drift and feedback starts an incremental planner', async () => {
  const f = fixture(provider()); await repo(f.root);
  try {
    const input = await f.project.submit('做一个页面');
    await until(() => f.store.task(input.task.id).status === 'completed');
    fs.writeFileSync(path.join(input.anchor.workspace, 'page.txt'), 'v1\n');
    await git(input.anchor.workspace, 'add', 'page.txt'); await git(input.anchor.workspace, 'commit', '-m', 'v1');
    const prepared = await f.project.prepareCandidate(input.id);
    await until(() => f.store.candidate(prepared.id).status === 'ready');

    const revision = f.project.requestCandidateChanges(prepared.id, '按钮需要更明显');
    expect(revision.candidate.status).toBe('changes_requested');
    expect(revision.planner.role).toBe('planner');
    expect(f.store.get('SELECT task_id FROM inputs WHERE id=?', input.id).task_id).toBe(revision.planner.id);
    await until(() => f.store.task(revision.planner.id).status === 'completed');
  } finally { await f.close(); }
});
