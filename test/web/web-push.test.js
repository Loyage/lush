import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { fixture, until } from '../helpers.js';
import { RPCServer } from '../../src/rpc/server.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { createSignal } from '../../src/signal.js';
import { sendWebPush } from '../../src/host/web-push-transport.js';
import { WEB_PUSH_PATHS as paths } from '../../src/shared/web-push-protocol.js';
import { fetch, rawFetch, startTestWeb } from './auth-fixture.js';

// A single retained main flow: real HTTP auth -> Host registration -> source RPC/SQLite ->
// actual VAPID/encryption -> controlled vendor endpoint. No network or real subscription is used.
test('Host Web Push subscribes privately and delivers only new source Notices across a sender restart', async () => {
  const f = fixture(), received = [], client = createECDH('prime256v1'); client.generateKeys();
  const authSecret = randomBytes(16), endpoint = 'https://fcm.googleapis.com/fcm/send/synthetic-test-only';
  const subscription = { endpoint, expirationTime: null,
    keys: { p256dh: client.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') } };
  let clock = Date.now(), web, port;
  const rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {}));
  const options = { env: f.config.env, userServiceOptions: { pushOptions: { intervalMs: 20, now: () => clock,
    send: request => sendWebPush({ ...request, fetch: async (url, init) => {
      expect(url).toBe(endpoint); expect(init.redirect).toBe('error');
      expect(init.headers['Content-Encoding']).toBe('aes128gcm');
      const match = /^vapid t=([^,]+), k=(.+)$/.exec(init.headers.Authorization);
      expect(match).not.toBeNull();
      const [header, claims, signature] = match[1].split('.');
      const publicKey = Buffer.from(match[2], 'base64url');
      const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: publicKey.subarray(1, 33).toString('base64url'),
        y: publicKey.subarray(33).toString('base64url') }, format: 'jwk' });
      expect(verify('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true);
      expect(JSON.parse(Buffer.from(claims, 'base64url'))).toMatchObject({ aud: 'https://fcm.googleapis.com' });
      const body = Buffer.from(init.body), salt = body.subarray(0, 16), length = body[20];
      expect(body.readUInt32BE(16)).toBe(4096); expect(length).toBe(65);
      const serverKey = body.subarray(21, 21 + length), shared = client.computeSecret(serverKey);
      const info = Buffer.concat([Buffer.from('WebPush: info\0'), client.getPublicKey(), serverKey]);
      const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, info, 32));
      const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const cipher = body.subarray(21 + length), decipher = createDecipheriv('aes-128-gcm', cek, nonce);
      decipher.setAuthTag(cipher.subarray(-16));
      const plaintext = Buffer.concat([decipher.update(cipher.subarray(0, -16)), decipher.final()]);
      expect(plaintext.at(-1)).toBe(2);
      received.push(JSON.parse(plaintext.subarray(0, -1).toString()));
      return new Response(null, { status: 201 });
    } }) } } };
  const sourceId = (await import('../../src/host/registry.js')).projectRouteId(f.config.project);
  const state = () => {
    const file = fs.readdirSync(f.config.deviceHome).find(name => /^web-push-.*\.json$/.test(name));
    return file ? JSON.parse(fs.readFileSync(path.join(f.config.deviceHome, file), 'utf8')) : null;
  };
  let base;
  const post = (route, body, extra = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...extra });
  try {
    await rpc.start(); web = startTestWeb(f.config, 0, options); port = web.port; base = `http://127.0.0.1:${port}`;
    const task = f.store.create({ input_id: null, role: 'worker', goal: 'private push source' });
    const addNotice = title => f.store.run("INSERT INTO notices(task_id,title,body,status,kind,created_at) VALUES (?,?,?,'open','question',?)",
      task.id, title, 'private code and question content must never leave Lush', new Date(++clock).toISOString());
    const addReported = title => {
      const source = f.store.event(task.id, 'notice.reported', { title });
      return f.store.run("INSERT INTO notices(task_id,title,body,status,kind,source_event_id,created_at) VALUES (?,?,?,'sent','info',?,?)",
        task.id, title, 'private Agent report', source, new Date(++clock).toISOString());
    };
    const setReported = async system => {
      const model = await (await fetch(base + '/api/host/preferences')).json();
      const channels = { ...model.values.noticeChannels, reported: { ...model.values.noticeChannels.reported, system } };
      expect((await post('/api/host/preferences', { patch: { noticeChannels: channels }, expected_revision: model.revision })).status).toBe(200);
    };
    addNotice('historical'); addReported('historical Agent report');
    expect((await rawFetch(base + paths.config)).status).toBe(401);
    expect((await post(paths.subscribe, { subscription }, { headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.invalid' } })).status).toBe(403);
    const config = await (await fetch(base + paths.config)).json();
    expect(config.public_key).toHaveLength(87); expect(Object.keys(config).sort()).toEqual(['public_key', 'version']);
    expect((await post(paths.subscribe, { subscription: { ...subscription, endpoint: 'http://127.0.0.1/secret' } })).status).toBe(400);
    expect((await post(paths.subscribe, { subscription, _token: 'not-a-user' })).status).toBe(400);
    const preferences = await (await fetch(base + '/api/host/preferences')).json();
    expect((await post('/api/host/preferences', { patch: { noticeNotifications: true }, expected_revision: preferences.revision })).status).toBe(200);
    expect((await post(paths.subscribe, { subscription })).status).toBe(200);
    expect(await (await post(paths.status, { endpoint })).json()).toEqual({ version: 1, subscribed: true });
    await until(() => state()?.sources[sourceId]?.ready);
    expect(received).toHaveLength(0);
    const result = addNotice('do not expose this title');
    const noticeId = Number(result.lastInsertRowid);
    await until(() => received.length === 1);
    expect(received[0]).toMatchObject({ version: 1, url: `/p/${sourceId}/#notices-${noticeId}` });
    expect(JSON.stringify(received)).not.toContain('do not expose');
    expect(JSON.stringify(received)).not.toContain('private code');
    await until(() => state()?.queue.length === 0);
    await setReported(false); addReported('disabled Agent report');
    f.store.run("UPDATE notices SET status='answered',answer='done' WHERE id=?", noticeId);
    const revision = f.store.get('SELECT MAX(seq) AS n FROM notice_sync_changes').n;
    await until(() => {
      const cursor = state()?.sources[sourceId]?.cursor;
      return cursor && JSON.parse(Buffer.from(cursor, 'base64url')).after >= revision;
    });
    expect(received).toHaveLength(1);
    await setReported(true);
    const reportedId = Number(addReported('private new Agent report').lastInsertRowid);
    await until(() => received.length === 2);
    expect(received[1]).toMatchObject({ url: `/p/${sourceId}/#notices-${reportedId}`, body: '有新的 Agent 告知，请打开 Lush 查看。' });
    expect(JSON.stringify(received)).not.toContain('private new Agent report');
    await until(() => state()?.queue.length === 0);
    const file = fs.readdirSync(f.config.deviceHome).find(name => /^web-push-.*\.json$/.test(name));
    expect(fs.statSync(path.join(f.config.deviceHome, file)).mode & 0o777).toBe(0o600);
    await web.stop(true); web = null;
    addNotice('created while Host sender was stopped');
    web = startTestWeb(f.config, port, options); base = `http://127.0.0.1:${port}`;
    // No browser/API request: actual Host startup must resume the persisted sender.
    await until(() => received.length === 3);
    await until(() => state()?.queue.length === 0);
    expect(await (await fetch(base + paths.config)).json()).toEqual(config);
    expect(await (await post(paths.test, { endpoint })).json()).toEqual({ version: 1, accepted: true });
    expect(received).toHaveLength(4);
    expect((await post(paths.test, { endpoint })).status).toBe(400);
    expect(await (await post(paths.unsubscribe, { endpoint })).json()).toEqual({ version: 1, subscribed: false });
    expect(await (await post(paths.status, { endpoint })).json()).toEqual({ version: 1, subscribed: false });
    expect(state().subscriptions).toHaveLength(0);
  } finally {
    await web?.stop(true); await rpc.close(); await f.close();
  }
});
