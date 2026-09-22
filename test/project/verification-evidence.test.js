import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, until, git } from '../helpers.js';

const provider = { async run() { return 'done'; } };

async function candidateFixture() {
  const f = fixture(provider); await repo(f.root);
  const input = await f.project.submit('验证结构化验收证据');
  await until(() => f.store.task(input.task.id).status === 'completed');
  fs.writeFileSync(path.join(input.anchor.workspace, 'result.txt'), 'candidate\n');
  await git(input.anchor.workspace, 'add', 'result.txt');
  await git(input.anchor.workspace, 'commit', '-m', 'candidate');
  f.project.stopping = true;
  return { f, input };
}

async function settle(f, input, evidence, { report = true } = {}) {
  const candidate = await f.project.prepareCandidate(input.id);
  const task = f.project.verifyCandidate(candidate.id);
  const reportPath = f.project.reportPath(task.id);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  if (report) fs.writeFileSync(reportPath, '<!doctype html><title>verification</title>');
  if (evidence) fs.writeFileSync(f.project.evidencePath(task.id), JSON.stringify(evidence));
  const verification = f.project.verificationEvidence(f.store.task(task.id));
  f.store.addArtifact({ task_id: task.id, input_id: task.input_id, kind: 'run.result', payload: {
    schema_version: 2, invocation: { status: 'completed' }, outcome: 'success', summary: evidence?.summary ?? 'no evidence', verification,
  } });
  f.project.finish(task.id, 'completed', 'verifier returned normally');
  return f.project.candidate(candidate.id);
}

const base = (status, extra = {}) => ({ schema_version: 1, status, summary: `${status} summary`,
  commands: status === 'unverified' ? [] : [{ command: 'bun run test', exit_code: status === 'fail' ? 1 : 0,
    baseline_exit_code: 0, summary: 'test comparison' }], failures: status === 'fail' ? ['test failed'] : [],
  unverified: status === 'partial' || status === 'unverified' ? ['scenario not covered'] : [],
  baseline_failures: [], residual_risks: [], ...extra });

test('candidate settlement preserves pass/fail/partial/unverified, missing-report and baseline-failure evidence', async () => {
  const { f, input } = await candidateFixture();
  try {
    const failed = await settle(f, input, base('fail'));
    expect(failed).toMatchObject({ status: 'failed', verification: { status: 'fail', failures: ['test failed'] } });

    const partial = await settle(f, input, base('partial'));
    expect(partial).toMatchObject({ status: 'failed', verification: { status: 'partial', unverified: ['scenario not covered'] } });

    const unverified = await settle(f, input, null);
    expect(unverified).toMatchObject({ status: 'failed', verification: { status: 'unverified' } });

    const noReport = await settle(f, input, base('pass'), { report: false });
    expect(noReport).toMatchObject({ status: 'failed', has_report: false, verification: { status: 'pass' } });

    const baselineFailure = await settle(f, input, base('pass', {
      commands: [{ command: 'bun run test', exit_code: 0, baseline_exit_code: 1, summary: 'candidate passes; baseline fails' }],
      baseline_failures: ['the same suite already fails on the frozen baseline'], residual_risks: ['baseline remains unhealthy'],
    }));
    expect(baselineFailure).toMatchObject({ status: 'ready', verification: {
      status: 'pass', tested_commit: baselineFailure.commit_hash, baseline_commit: baselineFailure.baseline_commit,
      baseline_failures: ['the same suite already fails on the frozen baseline'],
    } });

    const invalidCandidate = await f.project.prepareCandidate(input.id);
    const invalidTask = f.project.verifyCandidate(invalidCandidate.id);
    fs.mkdirSync(path.dirname(f.project.evidencePath(invalidTask.id)), { recursive: true });
    fs.writeFileSync(f.project.evidencePath(invalidTask.id), JSON.stringify({ ...base('pass'), status: 'success' }));
    expect(() => f.project.verificationEvidence(f.store.task(invalidTask.id)))
      .toThrow('verification evidence status must be pass, fail, partial or unverified');
  } finally { await f.close(); }
});

test('run.result read model marks historical artifacts without evidence unknown and rejects malformed new evidence', async () => {
  const f = fixture(provider); await repo(f.root);
  try {
    const task = f.store.create({ role: 'research', goal: 'legacy artifact' });
    const old = f.store.run(`INSERT INTO artifacts(task_id,kind,payload,metadata) VALUES (?,?,?,?)`,
      task.id, 'run.result', JSON.stringify({ outcome: 'success', summary: 'old result' }), '{}');
    expect(f.store.artifact(Number(old.lastInsertRowid)).payload).toMatchObject({
      schema_version: 1, invocation: { status: 'completed' }, verification: { status: 'unknown' },
    });
    expect(() => f.store.addArtifact({ task_id: task.id, kind: 'run.result', payload: {
      schema_version: 2, invocation: { status: 'completed' }, summary: 'bad',
      verification: { status: 'pass' },
    } })).toThrow(/tested_commit|verification/);
  } finally { await f.close(); }
});

test('candidate transition contract rejects illegal terminal rewrites', async () => {
  const { f, input } = await candidateFixture();
  try {
    const candidate = await f.project.prepareCandidate(input.id);
    f.project.rejectCandidate(candidate.id, 'done');
    expect(() => f.store.updateCandidate(candidate.id, { status: 'ready' }))
      .toThrow('invalid candidate transition rejected -> ready');
    expect(() => f.store.transitionCandidate(candidate.id, 'verification_requested', { report_task_id: 999 }))
      .toThrow(/cannot verification_requested/);
  } finally { await f.close(); }
});
