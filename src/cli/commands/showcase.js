import fs from 'node:fs';
import { check, id, isPlainObject } from '../../core/types.js';
import { option, exact } from '../args.js';

export async function run(command, args, { client }) {
  const verb = args.shift() || 'list';
  if (verb === 'start') {
    const baseline = option(args, '--baseline'); exact(args, 1);
    return client.request('showcase.start', { branch: args[0], baseline });
  }
  if (verb === 'list') {
    const branch = option(args, '--branch'); exact(args, 0);
    return client.request('showcase.list', { branch });
  }
  if (verb === 'stop') { exact(args, 1); return client.request('showcase.stop', { id: id(args[0]) }); }
  if (verb === 'preview') {
    const file = option(args, '--file'); exact(args, 0);
    check(file && fs.statSync(file).size <= 16384, '--file must be a preview JSON file no larger than 16384 bytes');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    check(isPlainObject(value) && Object.keys(value).every(key => ['command','path'].includes(key)), 'preview file accepts command and path only');
    return client.request('showcase.preview', value);
  }
  throw new Error('unknown showcase command; use start, list, stop or preview');
}
