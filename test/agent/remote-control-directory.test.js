import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from '../helpers.js';
import { createControlDirectory } from '../../src/core/project/runner-invocation.js';
import { RemoteControlResources } from '../../src/agent/remote-cooperation.js';

test('control directory uses the canonical real path when its temp ancestor is a symlink', () => {
  const root = temp();
  try {
    // macOS /var -> /private/var is one real instance; this alias makes the same shape cross-platform.
    const real = path.join(root, 'real-tmp');
    fs.mkdirSync(real, { mode: 0o700 });
    const alias = path.join(root, 'alias-tmp');
    fs.symlinkSync(real, alias, 'dir');
    const directory = createControlDirectory(alias);
    expect(path.dirname(directory)).toBe(fs.realpathSync(real));
    expect(fs.realpathSync(directory)).toBe(directory);
    expect(fs.lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(new RemoteControlResources({ directory }, 7).directory).toBe(directory);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('control directory validation still rejects permissive directories and symlink aliases', () => {
  const root = temp();
  try {
    const permissive = path.join(root, 'permissive');
    fs.mkdirSync(permissive, { mode: 0o700 });
    fs.chmodSync(permissive, 0o755);
    expect(() => new RemoteControlResources({ directory: permissive }, 1)).toThrow('Unsafe control directory');
    const real = path.join(root, 'real');
    fs.mkdirSync(real, { mode: 0o700 });
    const alias = path.join(root, 'alias');
    fs.symlinkSync(real, alias, 'dir');
    expect(() => new RemoteControlResources({ directory: alias }, 1)).toThrow('Unsafe control directory');
    expect(new RemoteControlResources({ directory: real }, 1).directory).toBe(real);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
