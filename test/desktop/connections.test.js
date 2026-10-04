import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeHostUrl, sameHost, sessionPartition, isProjectPage, workspaceIdentity, gatewayNoticeKey, ConnectionStore } from '../../src/ui/desktop/connections.js';

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
  const hex = '0123456789abcdef0123456789abcdef', uuid = '123e4567-e89b-42d3-a456-426614174000';
  for (const value of ['/', '/login', '/p/abcdef0123456789/', '/p/abcdef0123456789/#notices', `/e/${hex}/`, `/e/${uuid}/p/abcdef0123456789/`]) {
    expect(isProjectPage(host.slice(0, -1) + value)).toBe(true);
  }
  expect(workspaceIdentity(`${host}e/${hex}/p/abcdef0123456789/`)).toEqual({ type: 'gateway', environment: hex,
    project: 'abcdef0123456789', route: 'project' });
  for (const value of ['/api/docs/a', '/p/abcdef0123456789/api/worker/1/report', '/unknown', '/e/not-an-id/',
    `/e/${hex}/api/host`, `/e/${hex}/p/not-a-project/`, `/e/${uuid}/p/abcdef0123456789/extra`]) {
    expect(isProjectPage(host.slice(0, -1) + value)).toBe(false);
  }
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
    const gatewayA = gatewayNoticeKey('https://one.example.com/', '0123456789abcdef0123456789abcdef');
    const gatewayB = gatewayNoticeKey('https://one.example.com/', 'fedcba9876543210fedcba9876543210');
    store.setEnabled(gatewayA, true);
    expect(store.enabled(gatewayA)).toBe(true); expect(store.enabled(gatewayB)).toBe(false);
    expect(() => store.setEnabled('gateway:forged', true)).toThrow();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('notice channels persist per connection without changing legacy notification settings or shortcuts', () => {
  const dir = temporary();
  try {
    const store = new ConnectionStore(dir);
    const defaults = { idle: { banner: true, system: true }, analysis: { banner: true, system: true }, failed: { banner: true, system: true } };
    expect(store.noticePreferences('local')).toEqual(defaults);
    expect(store.noticePreferences('https://one.example.com')).toEqual(defaults);
    const local = { ...defaults, idle: { banner: false, system: true } };
    const remote = { ...defaults, analysis: { banner: true, system: false }, failed: { banner: false, system: false } };
    store.setEnabled('local', true);
    store.noticePreferences('local', local);
    store.noticePreferences('https://ONE.example.com:443', remote);
    store.remember('https://one.example.com');
    store.setEnabled('https://one.example.com/', false);
    store.remove('https://one.example.com');
    const restored = new ConnectionStore(dir);
    expect(restored.noticePreferences('local')).toEqual(local);
    expect(restored.noticePreferences('https://one.example.com')).toEqual(remote);
    expect(restored.noticePreferences('https://two.example.com')).toEqual(defaults);
    expect(restored.noticePreferences('https://one.example.com:444')).toEqual(defaults);
    expect(restored.enabled('local')).toBe(true);
    expect(restored.enabled('https://one.example.com/')).toBe(false);
    expect(restored.list()).toEqual([]);
    remote.failed.system = true; // Returned/caller objects never become mutable store state.
    const result = restored.noticePreferences('https://one.example.com');
    result.failed.system = true;
    expect(restored.noticePreferences('https://one.example.com').failed.system).toBe(false);
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(['connections.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('notice preference normalization accepts only own boolean whitelist channels', () => {
  const dir = temporary();
  try {
    const store = new ConnectionStore(dir);
    const defaults = store.noticePreferences('local');
    for (const value of [null, false, 0, 'false', [], { idle: false }, { idle: [] }]) {
      expect(store.noticePreferences('local', value)).toEqual(defaults);
    }
    const malicious = JSON.parse('{"idle":{"banner":false,"system":"false","__proto__":{"polluted":true}},"analysis":{"banner":0,"system":false,"unknown":false},"failed":{"banner":null},"unknown":{"banner":false},"__proto__":{"polluted":true}}');
    expect(store.noticePreferences('local', malicious)).toEqual({ idle: { banner: false, system: true }, analysis: { banner: true, system: false }, failed: { banner: true, system: true } });
    expect(JSON.parse(fs.readFileSync(store.file, 'utf8')).noticeChannels.local).toEqual(store.noticePreferences('local'));
    expect({}.polluted).toBeUndefined();
    expect(store.noticePreferences('local', Object.create({ idle: { banner: false, system: false } }))).toEqual(defaults);
    expect(store.noticePreferences('local', { idle: Object.create({ banner: false, system: false }) })).toEqual(defaults);
    for (const key of ['__proto__', 'http://evil.test/', '/tmp/preferences', 'https://good.test/p/123/']) {
      expect(() => store.noticePreferences(key, defaults)).toThrow();
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stored notice channels normalize corrupt values and default missing legacy records', () => {
  const dir = temporary();
  try {
    const store = new ConnectionStore(dir);
    const defaults = store.noticePreferences('local');
    for (const raw of ['null', '[]', '{broken', '{"notifications":{"local":true}}']) {
      fs.writeFileSync(store.file, raw);
      expect(store.noticePreferences('local')).toEqual(defaults);
    }
    fs.writeFileSync(store.file, JSON.stringify({ noticeChannels: { local: { idle: { banner: false, system: 'false' } },
      'https://ONE.example.com:443': { failed: { system: false } }, 'http://evil.test/': { failed: { system: false } } } }));
    expect(store.noticePreferences('local')).toEqual({ ...defaults, idle: { banner: false, system: true } });
    expect(store.noticePreferences('https://one.example.com')).toEqual({ ...defaults, failed: { banner: true, system: false } });
    expect(store.read().noticeChannels).not.toHaveProperty('http://evil.test/');
    store.remember('https://two.example.com');
    expect(new ConnectionStore(dir).noticePreferences('https://one.example.com').failed.system).toBe(false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UI preferences persist per key and project; reset preserves other projects and notification records', () => {
  const dir = temporary(), a = 'aaaaaaaaaaaaaaaa', b = 'bbbbbbbbbbbbbbbb';
  try {
    const one = new ConnectionStore(dir), two = new ConnectionStore(dir);
    one.setEnabled('local', true); one.noticePreferences('local', { failed: { system: false } });
    one.uiPreferences(a, { name: 'theme', value: 'dark' });
    two.uiPreferences(b, { name: 'polling', value: 'power' });
    one.uiPreferences(a, { name: 'taskGraphCollapsed', value: '[1,2]' });
    two.uiPreferences(b, { name: 'sidebarSort', value: 'updated' });
    const restored = new ConnectionStore(dir);
    expect(restored.uiPreferences(a).values).toEqual({ theme: 'dark', polling: 'power', taskGraphCollapsed: '[1,2]' });
    expect(restored.uiPreferences(b).values).toEqual({ theme: 'dark', polling: 'power', sidebarSort: 'updated' });
    expect(restored.uiPreferences(null).values).toEqual({ theme: 'dark', polling: 'power' });
    expect(restored.uiPreferences(a, { reset: true }).values).toEqual({});
    expect(two.uiPreferences(b).values).toEqual({ sidebarSort: 'updated' });
    one.uiPreferences(a, { name: 'markdown', value: '0' }); // Fresh per-key RMW never resurrects pre-reset snapshots.
    expect(two.uiPreferences(b).values).toEqual({ markdown: '0', sidebarSort: 'updated' });
    expect(restored.enabled('local')).toBe(true);
    expect(restored.noticePreferences('local').failed.system).toBe(false);
    expect(fs.statSync(path.join(dir, 'ui-preferences.json')).mode & 0o777).toBe(0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UI preference whitelist rejects arbitrary keys/identities and failed reads never replace stored data', () => {
  const dir = temporary(), project = 'aaaaaaaaaaaaaaaa';
  try {
    const store = new ConnectionStore(dir), file = path.join(dir, 'ui-preferences.json');
    store.uiPreferences(project, { name: 'theme', value: 'light' });
    const before = fs.readFileSync(file, 'utf8');
    for (const change of [{ name: 'noticeNotifications', value: '1' }, { name: '__proto__', value: '{}' },
      { name: '/tmp/secret', value: 'x' }, { name: 'theme', value: 'sepia' }, { name: 'filters', value: '{"path":"/tmp/x"}' },
      { name: 'theme', value: 'dark', project: 'bbbbbbbbbbbbbbbb' }, { reset: true, name: 'theme' }, { name: 'theme', value: 'x'.repeat(65537) }]) {
      expect(() => store.uiPreferences(project, change)).toThrow();
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    }
    expect(() => store.uiPreferences('/tmp/file', { reset: true })).toThrow();
    expect(() => store.uiPreferences(null, { name: 'sidebarSort', value: 'id' })).toThrow();
    fs.writeFileSync(file, '{broken');
    expect(() => store.uiPreferences(project)).toThrow();
    expect(() => store.uiPreferences(project, { name: 'theme', value: 'dark' })).toThrow();
    expect(() => store.uiPreferences(project, { reset: true })).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
    expect(fs.readdirSync(dir)).toEqual(['ui-preferences.json']);
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
