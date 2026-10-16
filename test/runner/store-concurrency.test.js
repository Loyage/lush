import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { withInitializationLock } from '../../src/runner/init-lock.js';

test('independent node processes serialize cold SQLite bootstrap and retain one installation identity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-runner-cold-'));
  const processes = [];
  try {
    const results = Array.from({ length: 8 }, () => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/cold-store.js', import.meta.url)), root],
        { env: { PATH: '/usr/bin:/bin', HOME: root }, stdio: ['pipe', 'pipe', 'pipe'] });
      processes.push(child);
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
      return new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`cold bootstrap exited ${code}: ${stderr}`)));
      });
    });
    for (const child of processes) child.stdin.end('start');
    const completed = await Promise.all(results);
    expect(new Set(completed.map(item => item.runner_id)).size).toBe(1);
    expect(completed.every(item => item.tables >= 7)).toBe(true);
  } finally {
    for (const child of processes) if (child.exitCode === null) child.kill('SIGKILL');
    await Promise.all(processes.filter(child => child.exitCode === null).map(child => new Promise(resolve => child.once('close', resolve))));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('bootstrap lock has a bounded admission deadline and releases after failures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-runner-lock-'));
  try {
    expect(() => withInitializationLock(root, () => withInitializationLock(root, () => {}, { timeout_ms: 20 }))).toThrow('deadline');
    expect(withInitializationLock(root, () => 'released')).toBe('released');
    fs.rmSync(path.join(root, 'initialize.lock'));
    fs.symlinkSync('/dev/null', path.join(root, 'initialize.lock'));
    expect(() => withInitializationLock(root, () => {})).toThrow();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
