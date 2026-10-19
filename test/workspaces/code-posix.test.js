import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createPosixFiles } from '../../src/core/workspaces/code-posix.js';
import { temp } from '../helpers.js';

test('POSIX openat reads regular files, rejects link traversal and readlinkat returns only link text', () => {
  const root = temp(), api = createPosixFiles(); let parent, file;
  try {
    fs.writeFileSync(path.join(root, 'file'), 'hello'); fs.symlinkSync('/etc/passwd', path.join(root, 'link'));
    parent = api.openDirectory(root); file = api.openAt(parent, 'file');
    expect(fs.fstatSync(file).isFile()).toBe(true);
    const bytes = Buffer.alloc(5); fs.readSync(file, bytes, 0, 5, 0); expect(bytes.toString()).toBe('hello');
    expect(() => api.openAt(parent, 'link')).toThrow('ELOOP');
    expect(api.readLinkAt(parent, 'link')).toBe('/etc/passwd');
  } finally {
    if (file !== undefined) fs.closeSync(file);
    if (parent !== undefined) fs.closeSync(parent);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
