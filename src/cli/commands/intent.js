import fs from 'node:fs';
import { check, isPlainObject } from '../../core/types.js';
import { exact, option } from '../args.js';

function readProfile(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.size <= 256 * 1024, 'invalid file');
    check(typeof process.getuid === 'function' && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'unsafe file');
    const source = fs.readFileSync(fd, 'utf8');
    check(Buffer.byteLength(source) <= 256 * 1024, 'invalid file');
    const value = JSON.parse(source);
    check(isPlainObject(value), 'invalid profile');
    return value;
  } catch { throw new Error('cannot safely read private Worker profile JSON file (owner-only regular file required)'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export async function run(command, args, ctx) {
  const { client } = ctx;
  let value;
  if (command === 'order') {
    check(!client.token, 'agents cannot submit orders');
    const branch = option(args, '--branch');
    const profileFile = option(args, '--profile-file');
    exact(args, 1);
    const profile = profileFile !== null ? readProfile(profileFile) : null;
    value = await client.request('order.submit', { content: args[0], ...(branch ? { branch } : {}), ...(profile ? { profile } : {}) });
  }
  return value;
}
