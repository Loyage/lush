import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeHostUrl, sameHost, sessionPartition, isProjectPage, ConnectionStore } from '../../src/ui/desktop/connections.js';

const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lush-desktop-test-'));

test('Host root normalization permits HTTPS and explicit loopback HTTP only', () => {
  for (const [input, output] of [
    [' https://LUSH.example.com:443 ', 'https://lush.example.com/'],
    ['http://127.0.0.1:4318', 'http://127.0.0.1:4318/'],
    ['http://localhost:9000/', 'http://localhost:9000/'],
    ['http://[::1]:9000', 'http://[::1]:9000/'],
  ]) expect(normalizeHostUrl(input)).toBe(output);
  for (const input of [null, '', 'lush.example.com', 'http://remote.example.com', 'http://192.168.1.2:4318',
    'http://localhost.evil.test', 'http://127.0.0.1.evil.test', 'file:///tmp/x', 'javascript:alert(1)',
    'https://user:secret@lush.example.com', 'https://user@lush.example.com', 'https://lush.example.com/p/123/',
    'https://lush.example.com/?secret=x', 'https://lush.example.com/#worker-1']) expect(() => normalizeHostUrl(input)).toThrow();
});

test('workspace origins and session partitions never confuse local and remote or two servers', () => {
  const host = 'https://one.example.com/';
  expect(sameHost('https://one.example.com/p/abcdef0123456789/#worker-1', host)).toBe(true);
  for (const target of ['https://two.example.com/', 'http://one.example.com/', 'https://one.example.com:444/',
    'https://one.example.com.evil.test/', 'https://secret@one.example.com/', 'file:///tmp/a', 'garbage']) expect(sameHost(target, host)).toBe(false);
  expect(sessionPartition('remote', host)).toBe(sessionPartition('remote', 'https://ONE.example.com:443'));
  expect(sessionPartition('remote', host)).not.toBe(sessionPartition('remote', 'https://two.example.com'));
  expect(sessionPartition('local', 'http://127.0.0.1:1234/')).toBe(sessionPartition('local', 'http://127.0.0.1:5678/'));
  expect(sessionPartition('remote', 'http://127.0.0.1:1234/')).not.toBe(sessionPartition('local', 'http://127.0.0.1:1234/'));
  for (const value of ['/', '/login', '/p/abcdef0123456789/', '/p/abcdef0123456789/#notices']) expect(isProjectPage(host.slice(0, -1) + value)).toBe(true);
  for (const value of ['/api/docs/a', '/p/abcdef0123456789/api/worker/1/report', '/unknown']) expect(isProjectPage(host.slice(0, -1) + value)).toBe(false);
});

test('connection shortcuts are canonical, bounded and persist independently of cookies and notices', () => {
  const dir = temporary();
  try {
    const store = new ConnectionStore(dir);
    expect(store.list()).toEqual([]);
    expect(store.enabled('https://one.example.com/')).toBe(false);
    store.remember('https://ONE.example.com'); store.remember('https://one.example.com/');
    expect(store.list()).toEqual(['https://one.example.com/']);
    for (let i = 0; i < 20; i++) store.remember(`https://host${i}.example.com`);
    expect(store.list()).toHaveLength(12);
    store.setEnabled('local', true); store.setEnabled('https://one.example.com/', true);
    expect(store.enabled('https://two.example.com/')).toBe(false);
    store.remember('https://one.example.com/'); store.remove('https://one.example.com/');
    const restored = new ConnectionStore(dir);
    expect(restored.list()).not.toContain('https://one.example.com/');
    expect(restored.enabled('local')).toBe(true);
    expect(restored.enabled('https://one.example.com/')).toBe(true);
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(['connections.json']);
    expect(() => store.setEnabled('local', 'yes')).toThrow();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt records fail closed and legacy notifications are restored for local Hosts only', () => {
  const dir = temporary();
  try {
    const store = new ConnectionStore(dir);
    fs.writeFileSync(path.join(dir, 'notifications.json'), '{"enabled":true}');
    fs.writeFileSync(store.file, '{broken');
    expect(store.list()).toEqual([]); expect(store.enabled('local')).toBe(true);
    expect(store.enabled('https://remote.example.com/')).toBe(false);
    fs.writeFileSync(store.file, JSON.stringify({ recent: ['http://evil.test/', 'file:///x', 'https://good.test', 'https://good.test/'],
      notifications: { local: false, 'http://evil.test/': true, 'https://good.test/': true } }));
    expect(store.list()).toEqual(['https://good.test/']);
    expect(store.enabled('local')).toBe(false); expect(store.enabled('http://evil.test/')).toBe(false);
    store.setEnabled('local', false);
    expect(new ConnectionStore(dir).enabled('local')).toBe(false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
