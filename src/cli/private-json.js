import fs from 'node:fs';
import { check, isPlainObject } from '../core/types.js';
import { option } from './args.js';

/** Same structured CLI input for humans and the fixed bridge; inline never reads a path. */
export function takeJsonInput(args, client, label = 'Hook') {
  const data = option(args, '--data'), file = option(args, '--file');
  check((data === null) !== (file === null), 'provide exactly one of --data JSON or --file PATH');
  if (data !== null) {
    check(Buffer.byteLength(data) <= 40000, 'inline JSON exceeds budget');
    const value = JSON.parse(data);
    check(isPlainObject(value), 'inline JSON must be an object');
    return value;
  }
  check(!client?.management, 'management CLI cannot read local files');
  return readPrivateJson(file, label);
}

/** Bounded, owner-only input; parse/read failures never echo private payloads. */
export function readPrivateJson(file, label = 'Hook', maxBytes = 256 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.size <= maxBytes, 'invalid file');
    check(typeof process.getuid === 'function' && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'unsafe file');
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!read) break;
      length += read;
    }
    check(length <= maxBytes, 'invalid file');
    const value = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    check(isPlainObject(value), 'invalid object');
    return value;
  } catch { throw new Error(`cannot safely read private ${label} JSON file (bounded owner-only regular file required)`); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
