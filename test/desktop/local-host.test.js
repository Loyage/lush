import { test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { env, temp, until } from '../helpers.js';
import { fetch } from '../web/harness.js';
import { createLocalHost } from '../../src/ui/desktop/local-host.js';

function fakeSpawner() {
  const calls = [], children = [];
  const spawn = (...args) => {
    calls.push(args); const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdout.setEncoding = child.stderr.setEncoding = () => {};
    child.killed = false; child.kill = signal => { child.killed = true; child.signal = signal; };
    children.push(child); return child;
  };
  return { spawn, calls, children };
}
const ready = (child, url = 'http://127.0.0.1:4318/') => child.stdout.emit('data', `LUSH_HOST_READY ${JSON.stringify({ url })}\n`);

test('local Host startup is single-flight, accepts split readiness and owns only its child', async () => {
  const fake = fakeSpawner();
  const host = createLocalHost({ root: '/code', bun: 'custom-bun', spawn: fake.spawn,
    env: { LUSH_PROJECT: '/project', LUSH_HOME: '/project/.lush', TEST: 'kept' } });
  const first = host.start(), second = host.start();
  expect(first).toBe(second); expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0].slice(0, 2)).toEqual(['custom-bun', ['/code/bin/lush-host', '0']]);
  expect(fake.calls[0][2].env).toEqual({ TEST: 'kept', LUSH_WEB_LAUNCHER: '1', LUSH_WEB_EPHEMERAL: '1' });
  const child = fake.children[0];
  child.stdout.emit('data', 'log message\nLUSH_HOST_RE'); child.stdout.emit('data', 'ADY {"url":"http://127.0.0.1:4318/"}\n');
  expect(await first).toBe('http://127.0.0.1:4318/');
  expect(await host.start()).toBe('http://127.0.0.1:4318/'); expect(fake.calls).toHaveLength(1);
  host.stop(); expect(child.signal).toBe('SIGTERM');
});

test('failed or timed-out local Host is stopped and a later attempt can start cleanly', async () => {
  const fake = fakeSpawner();
  const host = createLocalHost({ root: '/code', spawn: fake.spawn, timeoutMs: 15 });
  const failed = host.start();
  fake.children[0].emit('error', new Error('ENOENT'));
  await expect(failed).rejects.toThrow('无法启动 Bun');
  expect(fake.children[0].killed).toBe(true);
  const timedOut = host.start();
  await expect(timedOut).rejects.toThrow('启动超时');
  expect(fake.children[1].killed).toBe(true);
  const good = host.start(); ready(fake.children[2]);
  expect(await good).toBe('http://127.0.0.1:4318/'); host.stop();
});

test('local readiness rejects malformed or non-loopback endpoints and unexpected exits', async () => {
  for (const url of ['https://evil.test/', 'http://evil.test/', 'http://secret@127.0.0.1:4318/']) {
    const fake = fakeSpawner(), host = createLocalHost({ root: '/code', spawn: fake.spawn });
    const pending = host.start(); ready(fake.children[0], url);
    await expect(pending).rejects.toThrow('invalid local Host URL'); expect(fake.children[0].killed).toBe(true);
  }
  const fake = fakeSpawner(), host = createLocalHost({ root: '/code', spawn: fake.spawn });
  const pending = host.start(); fake.children[0].stderr.emit('data', 'test startup error'); fake.children[0].emit('exit', 1);
  await expect(pending).rejects.toThrow('test startup error');
});

test('quit during local Host startup cancels the owned startup instead of leaking a child', async () => {
  const fake = fakeSpawner(), host = createLocalHost({ root: '/code', spawn: fake.spawn });
  const pending = host.start(); host.stop();
  await expect(pending).rejects.toThrow('启动已取消');
  expect(fake.children[0].signal).toBe('SIGTERM');
});

test('real temporary local Host starts once and exits without starting project daemons', async () => {
  const global = temp();
  const root = path.resolve(import.meta.dir, '../..');
  const host = createLocalHost({ root, bun: process.execPath, env: env({ LUSH_GLOBAL_CONFIG: global }) });
  let url = null;
  try {
    url = await host.start();
    const status = await fetch(url + 'api/host').then(response => response.json());
    expect(status.mode).toBe('host'); expect(status.projects).toEqual([]);
    expect(await host.start()).toBe(url);
    expect((await fetch(url + 'api/host').then(response => response.json())).pid).toBe(status.pid);
    host.stop();
    let exited = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { await fetch(url + 'api/host'); } catch { exited = true; break; }
      await Bun.sleep(10);
    }
    expect(exited).toBe(true);
    await until(() => { try { process.kill(status.pid, 0); return false; } catch { return true; } }, 5000);
  } finally {
    host.stop(); fs.rmSync(global, { recursive: true, force: true });
  }
}, 20000);
