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

test('notice example is saveable JSON and offline check does not require a project', async () => {
  const root = temp();
  try {
    const example = await cli(root, 'notice', 'example');
    expect(example.code).toBe(0); expect(example.err).toBe('');
    const form = JSON.parse(example.out);
    expect(() => questionnaire('', form.questions)).not.toThrow();
    const file = path.join(root, 'questions.json'); fs.writeFileSync(file, example.out);
    const checked = await cli(root, 'notice', 'check', '--questions-file', file, '--body', '背景');
    expect(checked.code).toBe(0); expect(checked.err).toBe('');
    expect(JSON.parse(checked.out)).toEqual({ valid: true, question_count: 1 });
    expect(fs.readFileSync(file, 'utf8')).toBe(example.out);
    expect(fs.readdirSync(root)).toEqual(['questions.json']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
