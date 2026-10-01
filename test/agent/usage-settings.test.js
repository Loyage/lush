import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { UsageSettings, normalizeUsageConfig } from '../../src/agent/usage-settings.js';
import { temp } from '../helpers.js';

const query = () => ({ provider: 'custom-test', label: 'My quota', url: 'https://usage.example.test/v1/limits', method: 'GET',
  headers: { Authorization: 'Bearer ${USAGE_API_KEY}' }, body: null, kind: 'quota', items: [
    { id: 'credits', label: 'Credits', unit: 'USD', remaining: 'data.remaining', total: 'data.limit', used: null, reset_at: 'data.reset', window_seconds: null },
  ] });
const config = () => ({ version: 1, enabled: false, interval_minutes: 5, retention_days: 90, providers: ['custom-test'], custom: [query()] });

test('usage settings default to on-demand, 5 minutes and 90 days; save is owner-only and detached', () => {
  const home = temp(), settings = new UsageSettings({ home });
  try {
    expect(settings.get()).toEqual({ version: 1, enabled: false, interval_minutes: 5, retention_days: 90, providers: [], custom: [] });
    const value = config(); expect(settings.save(value)).toEqual(value);
    expect(fs.statSync(settings.file).mode & 0o777).toBe(0o600);
    value.custom[0].headers.Authorization = 'changed';
    expect(settings.get().custom[0].headers.Authorization).toBe('Bearer ${USAGE_API_KEY}');
    expect(fs.readdirSync(home)).toEqual(['agent-usage.json']);
    expect(settings.save({})).toEqual(normalizeUsageConfig({}));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('usage settings reject unknown, duplicate, invalid and over-budget configuration', () => {
  for (const patch of [null, [], { version: 2 }, { injected: 1 }, { enabled: 'yes' }, { interval_minutes: 0 },
    { interval_minutes: 1441 }, { retention_days: 3651 }, { retention_days: 1.5 }, { providers: ['x','x'] },
    { providers: ['bad/provider'] }, { custom: [query(),query()] }, { custom: Array(21).fill(query()) }])
    expect(() => normalizeUsageConfig(patch)).toThrow();
  for (const change of [q => { q.extra = 'x'; }, q => { q.items[0].script = 'x'; }, q => { q.items[0].remaining = '__proto__.value'; },
    q => { q.items[0].remaining = 'constructor.x'; }, q => { q.items[0].remaining = '$.data'; }, q => { q.items[0].window_seconds = -1; },
    q => { q.items = []; }, q => { q.items.push(q.items[0]); }, q => { q.label = '\n'; }]) {
    const q = query(); change(q); expect(() => normalizeUsageConfig({ custom: [q] })).toThrow();
  }
});

test('HTTP config is declarative, HTTPS-only, and credential templates cannot reference invocations', () => {
  for (const url of ['http://usage.example.test', 'https://owner:secret@usage.example.test', 'https://usage.example.test/#a',
    'https://${HOST}/quota', 'https://usage.example.test/?token=secret', 'not-a-url']) {
    const q = query(); q.url = url; expect(() => normalizeUsageConfig({ custom: [q] })).toThrow();
  }
  for (const headers of [{ Authorization: 'Bearer literal-secret' }, { 'X-API-Key': 'literal' }, { Cookie: 'session=abc' },
    { Authorization: '${LUSH_AGENT_TOKEN}' }, { Authorization: '${PI_SESSION_FILE}' }, { Host: 'elsewhere' },
    { 'Content-Length': '99' }, { 'X-Test': 'first\nsecond' }, { 'X-Test': '${unterminated' }, { Accept: 'a', accept: 'b' }]) {
    const q = query(); q.headers = headers; expect(() => normalizeUsageConfig({ custom: [q] })).toThrow();
  }
  const q = query(); q.method = 'POST'; q.headers['Content-Type'] = 'application/json'; q.body = '{"token":"${USAGE_TOKEN}","scope":"quota"}';
  expect(normalizeUsageConfig({ custom: [q] }).custom[0]).toEqual(q);
  q.body = '{"token":"raw-secret"}'; expect(() => normalizeUsageConfig({ custom: [q] })).toThrow();
  q.body = 'not JSON'; expect(() => normalizeUsageConfig({ custom: [q] })).toThrow();
  q.method = 'GET'; q.body = '{}'; expect(() => normalizeUsageConfig({ custom: [q] })).toThrow();
});

test('corrupt and unsafe files are never silently overwritten, including dangling symlinks', () => {
  const home = temp(), settings = new UsageSettings({ home });
  try {
    fs.writeFileSync(settings.file, '{corrupt SECRET', { mode: 0o600 });
    expect(() => settings.get()).toThrow('invalid JSON'); expect(() => settings.save({})).toThrow('invalid JSON');
    expect(fs.readFileSync(settings.file, 'utf8')).toBe('{corrupt SECRET');
    fs.writeFileSync(settings.file, '{}'); fs.chmodSync(settings.file, 0o644);
    expect(() => settings.get()).toThrow('unsafe');
    fs.unlinkSync(settings.file); fs.symlinkSync(path.join(home, 'missing'), settings.file);
    expect(() => settings.get()).toThrow('unsafe'); expect(() => settings.save({})).toThrow('unsafe');
    expect(fs.lstatSync(settings.file).isSymbolicLink()).toBe(true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
