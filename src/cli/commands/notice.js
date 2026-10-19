import fs from 'node:fs';
import { id, check } from '../../core/types.js';
import { questionsFromFile } from './question.js';
import { option, exact, print } from '../args.js';
import { resolveWorkerId } from '../worker-number.js';
import { takeOptions } from '../command-options.js';

export async function run(command, args, ctx = {}) {
  const { client } = ctx;
  let value;
  if (command === 'notice') {
    const verb = args.shift();
    if (['page','sync'].includes(verb)) {
      const params = takeOptions(args, verb === 'page' ? { status: 'string', before: 'number', limit: 'number' } : { cursor: 'string', limit: 'number' });
      exact(args, 0); return client.request(`notice.${verb}`, params);
    }
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
