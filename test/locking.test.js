import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { DaemonLock, isLocked, lockOwner } from '../src/daemon/locking.js';
import { temp } from './helpers.js';

test('the advisory lock admits one holder, reports state, and is released on UN', () => {
  const home = temp();
  try {
    const a = new DaemonLock(home);
    a.acquire();
    expect(a.held).toBe(true);
    expect(isLocked(home)).toBe(true);
    expect(lockOwner(home)).toBe(process.pid);
    const b = new DaemonLock(home);
    expect(() => b.acquire()).toThrow('already running');
    a.release();
    expect(isLocked(home)).toBe(false);
    b.acquire();
    expect(b.held).toBe(true);
    b.release();
    expect(isLocked(home)).toBe(false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a lock file left behind by a dead process never blocks the next holder', () => {
  const home = temp();
  try {
    fs.mkdirSync(home, { recursive: true });
    // A crashed process cannot have released a PID-file lock; flock does not care about the text.
    fs.writeFileSync(path.join(home, 'daemon.lock'), '999999999');
    const a = new DaemonLock(home);
    a.acquire();
    expect(a.held).toBe(true);
    expect(lockOwner(home)).toBe(process.pid);
    a.release();
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('concurrent processes never hold the lock at the same time', async () => {
  const home = temp();
  const log = path.join(home, 'holders.log');
  const script = path.join(home, 'contender.mjs');
  const modulePath = new URL('../src/daemon/locking.js', import.meta.url).pathname;
  fs.writeFileSync(script, `
import fs from 'node:fs';
import { DaemonLock } from ${JSON.stringify(modulePath)};
const [home, log] = process.argv.slice(2);
const lock = new DaemonLock(home);
let acquired = false;
for (let attempt = 0; attempt < 500 && !acquired; attempt += 1) {
  try { lock.acquire(); acquired = true; }
  catch { await Bun.sleep(2 + Math.floor(Math.random() * 8)); }
}
if (!acquired) process.exit(3);
fs.appendFileSync(log, '+\\n');
await Bun.sleep(30 + Math.floor(Math.random() * 40));
fs.appendFileSync(log, '-\\n');
lock.release();
`);
  try {
    const children = Array.from({ length: 6 }, () =>
      Bun.spawn([process.execPath, script, home, log], { stdout: 'ignore', stderr: 'ignore' }));
    const codes = await Promise.all(children.map(child => child.exited));
    expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
    const events = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
    expect(events.filter(value => value === '+').length).toBe(6);
    let held = 0;
    for (const event of events) {
      held += event === '+' ? 1 : -1;
      expect(held).toBeLessThanOrEqual(1);
      expect(held).toBeGreaterThanOrEqual(0);
    }
    expect(held).toBe(0);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
