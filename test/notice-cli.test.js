import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { questionnaire } from '../src/core/questionnaire.js';
import { env, temp } from './helpers.js';

const bin = new URL('../bin/lushw', import.meta.url).pathname;
async function cli(root, ...args) {
  const proc = Bun.spawn([process.execPath, bin, ...args], { cwd: root, env: env(), stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}

test('question construction and check are offline JSON without publishing or changing input files', async () => {
  const root = temp();
  try {
    const example = await cli(root, 'question', 'example');
    expect(example.code).toBe(0); expect(example.err).toBe('');
    const form = JSON.parse(example.out);
    expect(() => questionnaire('', form.questions)).not.toThrow();
    const file = path.join(root, 'questions.json'); fs.writeFileSync(file, example.out);
    const created = await cli(root, 'question', 'create', '决策标题', '--questions-file', file, '--body', '背景');
    expect(created.code).toBe(0); expect(created.err).toBe('');
    const question = JSON.parse(created.out);
    expect(question).toEqual({ ...JSON.parse(questionnaire('背景', form.questions)), title: '决策标题' });
    const decision = path.join(root, 'decision.json'); fs.writeFileSync(decision, created.out);
    const checked = await cli(root, 'question', 'check', '--question-file', decision);
    expect(checked.code).toBe(0); expect(checked.err).toBe('');
    expect(JSON.parse(checked.out)).toEqual({ valid: true, question_count: 1 });
    expect(fs.readFileSync(file, 'utf8')).toBe(example.out);
    expect(fs.readFileSync(decision, 'utf8')).toBe(created.out);
    expect(fs.readdirSync(root).sort()).toEqual(['decision.json', 'questions.json']);
    const machine = await cli(root, 'question', 'create', 'JSON决策', '--questions-file', file, '--json');
    expect(machine.code).toBe(0);
    expect(JSON.parse(machine.out).data.title).toBe('JSON决策');
    fs.writeFileSync(decision, machine.out);
    expect((await cli(root, 'question', 'check', '--question-file', decision)).code).toBe(0);
    // Construction errors and the retired command fail without project discovery or RPC.
    fs.writeFileSync(file, JSON.stringify({ questions: [] }));
    expect((await cli(root, 'question', 'create', 'bad', '--questions-file', file)).code).not.toBe(0);
    expect((await cli(root, 'question', 'check', '--question-file', file)).code).not.toBe(0);
    expect((await cli(root, 'question', 'create', 'bad', '--questions-file', file, '--questions-file', file)).code).not.toBe(0);
    expect((await cli(root, 'question', 'check', '--question-file', decision, '--unexpected')).code).not.toBe(0);
    expect((await cli(root, 'notice', 'example')).code).not.toBe(0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
