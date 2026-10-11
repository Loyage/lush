import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setup, fetch } from './harness.js';
import { startTestWeb } from './auth-fixture.js';
import { projectRouteId } from '../../src/host/registry.js';
import { RPCClient } from '../../src/rpc/client.js';
import { PARAMS, USER_ONLY, assertAllowed } from '../../src/rpc/registry.js';
import { tokenHash } from '../../src/core/project/internal.js';
import { temp } from '../helpers.js';

const create = f => f.store.create({ role: 'agent', task_kind: 'order', goal: 'reading' });
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('reading RPC/HTTP reads real Store records, preserve decoded text and fail closed on ownership/parameters/Agents', async () => {
  const f = await setup(), a = create(f), b = create(f), token = 'reading-test-token';
  try {
    const messageId = f.store.message(a.id, 'x'.repeat(30000) + '\nTailMatch');
    const inputId = f.store.event(a.id, 'message', { sender: null, message_id: messageId, append_number: 'A8-1' });
    const eventId = f.store.event(a.id, 'notice.answered', { answer: { retry_profile: 'legitimate textual answer', answer_source: 'not provenance', choice: '\n完整答复' }, answer_source: 'lush', notice_id: 7 });
    const rpc = new RPCClient(f.config.socket);
    const response = await fetch(f.url + `/api/worker/${a.id}/reading-page?query=tailmatch&limit=1`);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ events: [], messages: [{ id: messageId, body: 'x'.repeat(24000), text_truncated: true, total_chars: 30010,
      input_event: { id: inputId, task_id: a.id, type: 'message', data: { sender: null, message_id: messageId, append_number: 'A8-1' },
        input_delivery: { status: 'pending', at: null } } }], scanned_events: 1, scanned_messages: 1 });
    const body = await fetch(f.url + `/api/worker/${a.id}/reading-record?kind=message&record_id=${messageId}&offset=24000`);
    expect(await body.json()).toMatchObject({ text: 'x'.repeat(6000) + '\nTailMatch', offset: 24000, next_offset: 30010, has_more: false });
    const eventText = await rpc.request('worker.reading_record', { id: a.id, kind: 'event', record_id: eventId });
    expect(eventText.text).toBe(JSON.stringify({ retry_profile: 'legitimate textual answer', answer_source: 'not provenance', choice: '\n完整答复' }));
    expect((await rpc.request('worker.reading_page', { id: a.id })).events[0]).toMatchObject({ answer_source: 'lush', data: { notice_id: 7, answer_source: 'lush', answer: eventText.text } });
    for (const [method, params] of [
      ['worker.reading_page', { id: a.id, before_event: -1 }], ['worker.reading_page', { id: a.id, before_message: '1' }],
      ['worker.reading_page', { id: a.id, limit: 101 }], ['worker.reading_page', { id: a.id, query: 7 }],
      ['worker.reading_page', { id: a.id, cwd: '/etc' }], ['worker.reading_page', { id: 9999 }],
      ['worker.reading_record', { id: b.id, kind: 'message', record_id: messageId }],
      ['worker.reading_record', { id: b.id, kind: 'event', record_id: eventId }],
      ['worker.reading_record', { id: a.id, kind: 'notice', record_id: eventId }],
      ['worker.reading_record', { id: a.id, kind: 'event', record_id: eventId, offset: -1 }],
    ]) await expect(rpc.request(method, params)).rejects.toThrow();
    for (const suffix of ['reading-page?cwd=/etc', 'reading-page?query=a&query=b', 'reading-page?_token=',
      'reading-page?limit=', 'reading-page?limit=1.5', 'reading-page?before_event=-1', 'reading-page?before_message=NaN',
      'reading-record?kind=event&record_id=1&offset=1&offset=2', 'reading-record?project=/other', 'reading-record?kind=event']) {
      expect((await fetch(f.url + `/api/worker/${a.id}/${suffix}`)).status).toBe(400);
    }
    f.store.update(a.id, { status: 'running' }); f.store.armAgent(a.id, tokenHash(token));
    f.project.running.set(a.id, { token, controller: new AbortController() });
    for (const method of ['worker.reading_page','worker.reading_record']) {
      expect(USER_ONLY.has(method)).toBe(true); expect(PARAMS[method]).toContain('id');
      expect(() => assertAllowed(method, { id: a.id }, a.id)).toThrow('requires user approval');
      const params = method === 'worker.reading_page' ? { id: a.id, _token: token }
        : { id: a.id, kind: 'event', record_id: eventId, _token: token };
      await expect(rpc.request(method, params)).rejects.toThrow('requires user approval');
      expect((await post(f.url + '/api/action', { method, params: { id: a.id } })).status).toBe(400);
    }
    expect((await fetch(f.url + `/api/worker/${a.id}/reading-page`, { headers: { Origin: 'https://attacker.invalid' } })).status).toBe(403);
    expect(f.project.running.get(a.id).controller.signal.aborted).toBe(false);
  } finally { f.project.running.clear(); await f.close(); }
});

test('reading requires Web login and overview never automatically scans history', async () => {
  const f = await setup({ auth: { username: 'owner', password: 'test-password' } }), a = create(f);
  let reads = 0; const original = f.store.readingPage;
  f.store.readingPage = function (...args) { reads++; return original.apply(this, args); };
  try {
    expect((await fetch(f.url + `/api/worker/${a.id}/reading-page`)).status).toBe(401);
    expect((await fetch(f.url + `/api/worker/${a.id}/reading-record?kind=event&record_id=1`)).status).toBe(401);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=test-password&next=%2F' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    await fetch(f.url + '/api/overview', { headers: { Cookie: cookie } }); expect(reads).toBe(0);
    expect((await fetch(f.url + `/api/worker/${a.id}/reading-page?before_event=0&before_message=0`, { headers: { Cookie: cookie } })).status).toBe(200);
    expect(reads).toBe(1);
  } finally { await f.close(); }
});

test('reading HTTP forwards only URL-bound project identity, never a path or last selected project', async () => {
  const a = temp(), b = temp(), global = temp(), calls = [];
  const web = startTestWeb(null, 0, { env: { ...process.env, LUSH_GLOBAL_CONFIG: global }, openProject: async project => ({
    config: { project, home: path.join(project, '.lush') }, client: { async request(method, params = {}) { calls.push({ project, method, params }); return { project }; } },
  }) });
  const url = `http://127.0.0.1:${web.port}`, idA = projectRouteId(a), idB = projectRouteId(b);
  try {
    await post(url + '/api/host/select', { project: a }); await post(url + '/api/host/select', { project: b }); calls.length = 0;
    expect(await (await fetch(`${url}/p/${idA}/api/worker/7/reading-page?before_event=3&before_message=0&limit=2&query=关键词`)).json()).toEqual({ project: a });
    expect(await (await fetch(`${url}/p/${idB}/api/worker/7/reading-record?kind=message&record_id=2&offset=4`)).json()).toEqual({ project: b });
    expect(calls).toEqual([
      { project: a, method: 'worker.reading_page', params: { id: 7, before_event: 3, before_message: 0, limit: 2, query: '关键词' } },
      { project: b, method: 'worker.reading_record', params: { id: 7, kind: 'message', record_id: 2, offset: 4 } },
    ]);
    expect((await fetch(url + '/api/worker/7/reading-page')).status).toBe(400);
    expect((await fetch(`${url}/p/${'0'.repeat(16)}/api/worker/7/reading-page`)).status).toBe(400);
    expect((await fetch(`${url}/p/${idA}/api/worker/7/reading-page?project=${encodeURIComponent(b)}`)).status).toBe(400);
    expect(calls).toHaveLength(2);
  } finally { web.stop(true); for (const dir of [a, b, global]) fs.rmSync(dir, { recursive: true, force: true }); }
});
