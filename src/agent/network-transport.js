import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

const failure = () => new Error('Outbound network request failed');
const hostname = url => url.hostname.replace(/^\[|\]$/g, '');
const transport = url => url.protocol === 'https:' ? https : http;
function proxyHeaders(proxy) {
  if (!proxy.username && !proxy.password) return {};
  let user, password;
  try { user = decodeURIComponent(proxy.username); password = decodeURIComponent(proxy.password); } catch { throw failure(); }
  return { 'Proxy-Authorization': `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` };
}
function tunnel(target, proxy, signal) {
  return new Promise((resolve, reject) => {
    const authority = `${target.hostname}:${target.port || 443}`;
    const request = transport(proxy).request({ hostname: hostname(proxy), port: proxy.port || undefined,
      method: 'CONNECT', path: authority, headers: { Host: authority, ...proxyHeaders(proxy) }, signal });
    let settled = false, socket;
    const abort = () => { socket?.destroy(); request.destroy(); finish(failure()); };
    const finish = (error, value) => {
      if (settled) return; settled = true; signal?.removeEventListener('abort', abort);
      if (error) { socket?.destroy(); reject(failure()); } else resolve(value);
    };
    signal?.addEventListener('abort', abort, { once: true });
    request.on('error', () => finish(failure()));
    request.on('connect', (response, connected, head) => {
      socket = connected;
      if (response.statusCode !== 200 || head.length) { finish(failure()); return; }
      socket = tls.connect({ socket: connected, host: hostname(target), servername: isIP(hostname(target)) ? undefined : hostname(target),
        rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
      socket.once('error', () => finish(failure()));
      socket.once('secureConnect', () => finish(null, socket));
    });
    request.end();
    if (signal?.aborted) abort();
  });
}

/** Independent of process-wide proxy variables. No redirect following, fallback or TLS bypass. */
export async function outboundFetch(target, init = {}, proxyAddress = '') {
  const url = new URL(target), proxy = proxyAddress ? new URL(proxyAddress) : null, signal = init.signal;
  if (!['http:', 'https:'].includes(url.protocol) || signal?.aborted) throw failure();
  let agent, secure;
  if (proxy && url.protocol === 'https:') {
    secure = await tunnel(url, proxy, signal);
    agent = new https.Agent({ keepAlive: false });
    agent.createConnection = () => secure;
  }
  return new Promise((resolve, reject) => {
    let request, response, done = false;
    const abort = () => { request?.destroy(failure()); response?.destroy(failure()); secure?.destroy(); };
    const cleanup = () => { signal?.removeEventListener('abort', abort); agent?.destroy(); };
    const rejectSafe = () => { if (!done) { done = true; reject(failure()); } cleanup(); };
    try {
      const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
      // Never let service credentials masquerade as proxy credentials.
      delete headers['proxy-authorization']; delete headers['proxy-connection'];
      const forward = proxy && url.protocol === 'http:';
      const options = { method: init.method || 'GET', headers, signal, agent: agent || false };
      if (forward) {
        options.hostname = hostname(proxy); options.port = proxy.port || undefined;
        options.path = url.href; options.headers.Host = url.host;
        Object.assign(options.headers, proxyHeaders(proxy));
        request = transport(proxy).request(options);
      } else request = transport(url).request(url, options);
      signal?.addEventListener('abort', abort, { once: true });
      request.on('error', rejectSafe);
      request.on('response', incoming => {
        response = incoming;
        incoming.once('error', () => { /* body consumers receive stream failure, without raw socket details */ });
        incoming.once('close', cleanup);
        const decoder = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress }[incoming.headers['content-encoding']];
        let stream = incoming;
        if (decoder) {
          stream = decoder(); incoming.pipe(stream);
          incoming.on('error', () => stream.destroy(failure()));
          stream.on('error', () => incoming.destroy());
          stream.once('close', () => { if (!incoming.readableEnded) incoming.destroy(); });
        }
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
        if (decoder) { responseHeaders.delete('content-encoding'); responseHeaders.delete('content-length'); }
        const body = [204, 205, 304].includes(incoming.statusCode) || options.method === 'HEAD' ? null : Readable.toWeb(stream);
        if (!body) incoming.resume();
        done = true;
        resolve(new Response(body, { status: incoming.statusCode, headers: responseHeaders }));
      });
      let body = init.body;
      if (body instanceof URLSearchParams) body = body.toString();
      if (body !== undefined && body !== null && typeof body !== 'string' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) throw failure();
      request.end(body);
      if (signal?.aborted) abort();
    } catch { request?.destroy(); secure?.destroy(); rejectSafe(); }
  });
}
