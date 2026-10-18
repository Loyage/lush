import fs from 'node:fs';
import { id, check } from '../../core/types.js';
import { questionnaire } from '../../core/questionnaire.js';
import { option, exact, print } from '../args.js';
import { resolveWorkerId } from '../worker-number.js';

// These commands inspect only code-owned examples or the explicitly supplied file.
export function isLocalCommand(args) {
  return args[0] === 'example' || args[0] === 'check';
}

export function questionsFromFile(file, body) {
  const hint = 'Expected {"questions":[...]} with 1-4 questions and 2-4 options per question; use lushw notice example for a complete JSON template.';
  let fd;
  try {
    // Do not block indefinitely on a pipe or attempt to read devices/directories.
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    check(fs.fstatSync(fd).isFile(), 'questions file must be a regular file');
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    check(Array.isArray(value?.questions), 'questions file must contain {questions:[...]}');
    questionnaire(body, value.questions); // Same limits and normalization as notice.post on the server.
    return value.questions;
  } catch (error) {
    throw new Error(`Invalid questions file ${JSON.stringify(file)}: ${error.message}. ${hint}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export async function run(command, args, ctx = {}) {
  const { client } = ctx;
  if (command === 'notice' && isLocalCommand(args)) {
    const verb = args.shift();
    if (verb === 'example') {
      exact(args, 0);
      return { questions: [{
        header: '方案选择', question: '本次改进采用哪种实现方案？',
        options: [
          { label: '复用现有实现（推荐）', description: '保持现有接口，改动较小；受现有结构限制。' },
          { label: '新增独立实现', description: '隔离新行为，但增加维护和集成成本。' },
        ], multiSelect: false,
      }] };
    }
    const file = option(args, '--questions-file'), body = option(args, '--body', '');
    check(file !== null && args.length === 0, 'use lushw notice check --questions-file FILE [--body TEXT]');
    const questions = questionsFromFile(file, body);
    return { valid: true, question_count: questions.length };
  }
  let value;
  if (command === 'notice') {
    const verb = args.shift();
    if (verb === 'list') { exact(args, 0); value = await client.request('notice.list'); }
    else if (verb === 'post') {
      const task = option(args, '--worker'), body = option(args, '--body', '');
      const file = option(args, '--questions-file'), kind = option(args, '--kind'); exact(args, 1);
      check(kind === null || ['question','info'].includes(kind), 'notice kind must be question or info');
      check(kind !== 'info' || file === null, 'an info notice cannot contain a questionnaire');
      let questions;
      if (file !== null) questions = questionsFromFile(file, body);
      value = await client.request('notice.post', { task: await resolveWorkerId(client, task), title: args[0], body, ...(kind !== null ? { kind } : {}), ...(questions !== undefined ? { questions } : {}) });
    } else if (verb === 'answer') {
      const file = option(args, '--answers-file'); exact(args, file === null ? 2 : 1);
      value = await client.request('notice.answer', { id: id(args[0]), answer: file === null ? args[1] : JSON.parse(fs.readFileSync(file, 'utf8')) });
    }
    else if (verb === 'dismiss') { exact(args, 1); value = await client.request('notice.dismiss', { id: id(args[0]) }); }
    else if (verb === 'read') { exact(args, 1); value = await client.request('notice.read', { id: id(args[0]) }); }
    else throw new Error('unknown notice command');
  }
  if (!ctx.json && value && typeof value === 'object' && !Array.isArray(value) && 'kind' in value && 'id' in value) {
    print([value], false); // Keep the full result below for questionnaire options/body and answer details.
  }
  return value;
}
