import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../src/cli/commands/notice.js';
import { questionnaire } from '../src/core/questionnaire.js';
import { cliHelp } from '../src/cli/catalog.js';
const HELP = cliHelp('lushw');
import { env, temp } from './helpers.js';

const bin = new URL('../bin/lushw', import.meta.url).pathname;
async function cli(root, ...args) {
  const proc = Bun.spawn([process.execPath, bin, ...args], {
    cwd: root, env: env({
      LUSH_PROJECT: path.join(root, 'missing-project'), LUSH_HOME: path.join(root, 'wrong-home'),
      LUSH_GLOBAL_CONFIG: path.join(root, 'broken-settings'), LUSH_AGENT_TOKEN: 'not-a-live-token',
    }), stdout: 'pipe', stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { out, err, code };
}
function write(root, value) {
  const file = path.join(root, 'questions.json');
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}
const noRPC = { request() { throw new Error('unexpected RPC'); } };

test('notice example is saveable JSON and offline check neither discovers nor writes project/device state', async () => {
  const root = temp();
  try {
    fs.writeFileSync(path.join(root, 'broken-settings'), 'not JSON');
    const example = await cli(root, 'notice', 'example');
    expect(example.code).toBe(0); expect(example.err).toBe('');
    const form = JSON.parse(example.out);
    expect(() => questionnaire('', form.questions)).not.toThrow();
    const file = write(root, example.out), before = fs.readFileSync(file, 'utf8');
    for (const flags of [[], ['--json'], ['--project', path.join(root, 'also-missing')]]) {
      const checked = await cli(root, 'notice', 'check', '--questions-file', file, '--body', '背景', ...flags);
      expect(checked.code).toBe(0); expect(checked.err).toBe('');
      expect(JSON.parse(checked.out)).toEqual({ valid: true, question_count: 1 });
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.readFileSync(path.join(root, 'broken-settings'), 'utf8')).toBe('not JSON');
    expect(fs.readdirSync(root).sort()).toEqual(['broken-settings', 'questions.json']);
    expect(HELP).toContain('notice example > questions.json');
    expect(HELP).toContain('notice check --questions-file');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('notice check and post reject the same invalid envelopes and schema before any RPC', async () => {
  const root = temp();
  try {
    const example = await run('notice', ['example']);
    const q = example.questions[0];
    const invalid = [
      ['{', 'JSON'], [null, '{questions:[...]}'], [example.questions, '{questions:[...]}'],
      [{ question: q }, '{questions:[...]}'], [{ questions: [] }, '1-4 questions'],
      [{ questions: Array(5).fill(q) }, '1-4 questions'],
      [{ questions: [{ ...q, header: 'x'.repeat(17) }] }, 'header'],
      [{ questions: [{ ...q, question: '' }] }, 'question'],
      [{ questions: [{ ...q, multiSelect: 'yes' }] }, 'multiSelect'],
      [{ questions: [{ ...q, surprise: true }] }, 'question fields'],
      [{ questions: [{ ...q, options: [q.options[0]] }] }, '2-4 options'],
      [{ questions: [{ ...q, options: Array(5).fill(q.options[0]) }] }, '2-4 options'],
      [{ questions: [{ ...q, options: q.options.map(o => ({ ...o, label: 'same' })) }] }, 'duplicate'],
      [{ questions: [{ ...q, options: [{ ...q.options[0], label: '其他' }, q.options[1]] }] }, 'Other'],
      [{ questions: [{ ...q, options: [{ ...q.options[0], description: '' }, q.options[1]] }] }, 'description'],
      [{ questions: [{ ...q, options: [{ ...q.options[0], preview: 'x'.repeat(12001) }, q.options[1]] }] }, 'preview'],
      [{ questions: [{ ...q, options: q.options.map(o => ({ ...o, previewHtml: '中'.repeat(16000) })) }] }, '64000 bytes'],
    ];
    for (const [value, message] of invalid) {
      const file = write(root, value === null ? 'null' : value);
      for (const args of [
        ['check', '--questions-file', file],
        ['post', 'Choose', '--worker', '17', '--questions-file', file],
      ]) {
        await expect(run('notice', args, { client: noRPC })).rejects.toThrow(message);
      }
    }
    const failed = await cli(root, 'notice', 'check', '--questions-file', write(root, example.questions));
    expect(failed.code).not.toBe(0);
    expect(failed.err).toContain('Expected {"questions":[...]}');
    expect(failed.err).toContain('lushw notice example');
    expect(failed.out).toBe('');
    const file = write(root, example);
    for (const verb of ['check', 'post']) {
      const args = verb === 'check' ? [verb] : [verb, 'Choose', '--worker', '17'];
      await expect(run('notice', [...args, '--questions-file', file, '--body', 'x'.repeat(8001)], { client: noRPC })).rejects.toThrow('body');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('notice file errors give correction guidance; local arguments fail without RPC', async () => {
  const root = temp();
  try {
    for (const file of [path.join(root, 'missing'), root]) {
      await expect(run('notice', ['check', '--questions-file', file], { client: noRPC })).rejects.toThrow('lushw notice example');
    }
    const fifo = path.join(root, 'fifo');
    expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0);
    await expect(run('notice', ['check', '--questions-file', fifo])).rejects.toThrow('regular file');
    for (const args of [
      ['example', 'extra'], ['example', '--body', 'ignored'], ['check'],
      ['check', '--questions-file'], ['check', '--questions-file', 'missing', '--worker', '17'],
      ['check', '--questions-file', 'missing', '--questions-file', 'duplicate'],
    ]) await expect(run('notice', args, { client: noRPC })).rejects.toThrow();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('validated post still sends the original request, while check never posts or looks up a Worker', async () => {
  const root = temp();
  try {
    const example = await run('notice', ['example']);
    example.questions[0].options[0].preview = 'Static **proposal**';
    example.questions[0].options[1].previewHtml = '<p>Static alternative</p>';
    const file = write(root, example), calls = [];
    const response = { id: 8, kind: 'questionnaire' };
    const client = { async request(method, params) { calls.push({ method, params }); return response; } };
    expect(await run('notice', ['check', '--questions-file', file, '--body', 'context'], { client })).toEqual({ valid: true, question_count: 1 });
    expect(calls).toEqual([]);
    expect(await run('notice', ['post', 'Choose', '--worker', '17', '--body', 'context', '--questions-file', file], { client, json: true })).toBe(response);
    expect(calls).toEqual([{ method: 'notice.post', params: { task: 17, title: 'Choose', body: 'context', questions: example.questions } }]);
    calls.length = 0;
    await run('notice', ['post', 'Text question', '--worker', '17'], { client, json: true });
    expect(calls).toEqual([{ method: 'notice.post', params: { task: 17, title: 'Text question', body: '' } }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
