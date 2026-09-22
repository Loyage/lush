import fs from 'node:fs';
import { id, check } from '../../core/types.js';
import { option, exact } from '../args.js';

export async function run(command, args, ctx) {
  const { client } = ctx;
  let value;
  if (command === 'notice') {
    const verb = args.shift();
    if (verb === 'list') { exact(args, 0); value = await client.request('notice.list'); }
    else if (verb === 'post') {
      const task = option(args, '--task', process.env.LUSH_TASK_ID), body = option(args, '--body', '');
      const file = option(args, '--questions-file'); exact(args, 1);
      let questions;
      if (file !== null) {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        check(Array.isArray(value?.questions), 'questions file must contain {questions:[...]}');
        questions = value.questions;
      }
      value = await client.request('notice.post', { task: id(task), title: args[0], body, ...(questions !== undefined ? { questions } : {}) });
    } else if (verb === 'answer') {
      const file = option(args, '--answers-file'); exact(args, file === null ? 2 : 1);
      value = await client.request('notice.answer', { id: id(args[0]), answer: file === null ? args[1] : JSON.parse(fs.readFileSync(file, 'utf8')) });
    }
    else if (verb === 'dismiss') { exact(args, 1); value = await client.request('notice.dismiss', { id: id(args[0]) }); }
    else throw new Error('unknown notice command');
  }
  return value;
}
