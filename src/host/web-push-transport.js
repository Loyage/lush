import { createCipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { check, isPlainObject } from '../core/types.js';

const b64 = (value, length) => {
  check(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value), 'invalid Web Push key');
  const bytes = Buffer.from(value, 'base64url');
  check(bytes.length === length && bytes.toString('base64url') === value, 'invalid Web Push key');
  return bytes;
};
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const expand = (key, label, size) => hmac(key, Buffer.concat([Buffer.from(label), Buffer.from([1])])).subarray(0, size);

/** Vendor-owned HTTPS endpoints only. Never follow an endpoint redirect or accept arbitrary URLs. */
export function pushEndpoint(value) {
  check(typeof value === 'string' && value.length <= 2048, 'invalid Web Push endpoint');
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid Web Push endpoint'); }
  const host = url.hostname;
  const allowed = host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com'
    || host === 'push.services.mozilla.com' || /^[a-z0-9-]+\.push\.apple\.com$/.test(host)
    || host === 'web.push.apple.com';
  check(allowed && url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
    && value === url.href && url.pathname !== '/', 'unsupported Web Push endpoint');
  // URL normalizes an explicit :443 away; reject it in the submitted authority too.
  check(!/^https:\/\/[^/]*:/.test(value), 'invalid Web Push endpoint');
  return url;
}

export function normalizePushSubscription(value) {
  check(isPlainObject(value) && Object.keys(value).every(key => ['endpoint', 'expirationTime', 'keys'].includes(key))
    && isPlainObject(value.keys) && Object.keys(value.keys).every(key => ['p256dh', 'auth'].includes(key)), 'invalid Web Push subscription');
  pushEndpoint(value.endpoint);
  check(value.expirationTime === undefined || value.expirationTime === null
    || (typeof value.expirationTime === 'number' && Number.isFinite(value.expirationTime)
      && value.expirationTime > 0 && value.expirationTime <= Number.MAX_SAFE_INTEGER), 'invalid Web Push expiration');
  const client = b64(value.keys.p256dh, 65); b64(value.keys.auth, 16);
  check(client[0] === 4, 'invalid Web Push key');
  try { const probe = createECDH('prime256v1'); probe.generateKeys(); probe.computeSecret(client); }
  catch { throw new Error('invalid Web Push key'); }
  return { endpoint: value.endpoint, expirationTime: value.expirationTime ?? null,
    keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}

export function createVapidKeys() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const key = privateKey.export({ format: 'jwk' });
  return { private_key: key, public_key: Buffer.concat([Buffer.from([4]), b64(key.x, 32), b64(key.y, 32)]).toString('base64url') };
}

export function validateVapidKeys(value) {
  check(isPlainObject(value) && isPlainObject(value.private_key) && value.private_key.kty === 'EC'
    && value.private_key.crv === 'P-256', 'invalid Web Push identity');
  const key = value.private_key;
  const privateKey = b64(key.d, 32);
  const publicKey = Buffer.concat([Buffer.from([4]), b64(key.x, 32), b64(key.y, 32)]).toString('base64url');
  const derived = createECDH('prime256v1'); derived.setPrivateKey(privateKey);
  check(value.public_key === publicKey && derived.getPublicKey().toString('base64url') === publicKey, 'invalid Web Push identity');
  createPrivateKey({ key, format: 'jwk' });
  return value;
}

/** RFC 8291: one aes128gcm record, authenticated final-record delimiter, no compression. */
export function encryptPushPayload(subscription, payload) {
  const client = b64(subscription.keys.p256dh, 65), auth = b64(subscription.keys.auth, 16);
  const plaintext = Buffer.from(JSON.stringify(payload));
  check(plaintext.length <= 3000, 'Web Push payload too large');
  const server = createECDH('prime256v1'); server.generateKeys();
  const publicKey = server.getPublicKey(), secret = server.computeSecret(client), salt = randomBytes(16);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), client, publicKey]);
  const ikm = hmac(hmac(auth, secret), Buffer.concat([info, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cipher = createCipheriv('aes-128-gcm', expand(prk, 'Content-Encoding: aes128gcm\0', 16), expand(prk, 'Content-Encoding: nonce\0', 12));
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21); salt.copy(header); header.writeUInt32BE(4096, 16); header[20] = publicKey.length;
  return Buffer.concat([header, publicKey, ciphertext]);
}

export function vapidAuthorization(keys, endpoint, subject, now = Date.now()) {
  const audience = pushEndpoint(endpoint).origin;
  const contact = new URL(subject);
  check(contact.protocol === 'https:' && !contact.username && !contact.password && contact.origin !== 'https://localhost', 'invalid Web Push contact origin');
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const message = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: contact.origin })}`;
  const signature = sign('sha256', Buffer.from(message), { key: createPrivateKey({ key: keys.private_key, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${message}.${signature.toString('base64url')}, k=${keys.public_key}`;
}

/** Accepted means the remote push service accepted the request, never that a phone displayed it. */
export async function sendWebPush({ subscription, keys, payload, subject, signal, fetch: send = globalThis.fetch, now = Date.now() }) {
  try {
    const endpoint = pushEndpoint(subscription.endpoint);
    const response = await send(endpoint.href, { method: 'POST', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
      headers: { Authorization: vapidAuthorization(keys, endpoint.href, subject, now),
        'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'normal' },
      body: encryptPushPayload(subscription, payload) });
    const status = response.status;
    await response.body?.cancel();
    return { status, accepted: status >= 200 && status < 300, expired: status === 404 || status === 410,
      retryable: status === 429 || status >= 500 };
  } catch { throw new Error('Web Push request did not complete'); }
}
