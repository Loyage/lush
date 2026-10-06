import fs from 'node:fs';
import { check, isPlainObject } from '../core/types.js';

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
