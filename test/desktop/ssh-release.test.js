import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createReleasePayloadProvider, desktopReleaseIdentity } from '../../src/ui/desktop/ssh-release.js';
import { createRemotePayload } from '../packaging/remote-fixture.js';

let root, payloadDir, userData, manifest, calls;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lush-release-test-')));
  payloadDir = path.join(root, 'release-input'); userData = path.join(root, 'client');
  manifest = createRemotePayload(root, payloadDir);
  calls = [];
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function asset(url, options) {
  calls.push({ url, options });
  return new Response(fs.readFileSync(path.join(payloadDir, new URL(url).pathname.split('/').at(-1))));
}
function provider(options = {}) {
  return createReleasePayloadProvider({ identity: manifest, userData, payloadDir: path.join(root, 'missing'), fetchImpl: asset, ...options });
}
function cache(target = 'linux-x64') {
  return path.join(userData, 'payload-cache', `payload-v${manifest.lush_version}-${manifest.fingerprint}`, target);
}

test('source identity is portable and does not depend on docs, scripts or generated packages', () => {
  expect(desktopReleaseIdentity(root)).toEqual({ lush_version: manifest.lush_version, fingerprint: manifest.fingerprint });
  fs.writeFileSync(path.join(root, 'docs/.DS_Store'), 'irrelevant desktop metadata');
  expect(desktopReleaseIdentity(root).fingerprint).toBe(manifest.fingerprint);
  fs.appendFileSync(path.join(root, 'src/identity.js'), '// real source edit');
  expect(desktopReleaseIdentity(root).fingerprint).not.toBe(manifest.fingerprint);
});

test('missing-payload preflight is offline and pins the publisher, version, identity and target', () => {
  const identity = { ...manifest }, p = provider({ identity }); identity.fingerprint = '0000000000000000';
  const plan = p.resolve('linux-arm64');
  expect(plan.download).toMatchObject({ repository: 'Loyage/lush', tag: `payload-v0.2.0-${manifest.fingerprint}`, file: 'lush-remote-linux-arm64.tar.gz' });
  expect(plan.download.releaseURL).toBe(`https://github.com/Loyage/lush/releases/tag/payload-v0.2.0-${manifest.fingerprint}`);
  expect(calls).toHaveLength(0); expect(fs.existsSync(userData)).toBe(false);
  expect(() => p.resolve('../escape')).toThrow('架构');
});

test('consented download validates one native target, caches atomically and then works offline', async () => {
  const p = provider();
  const downloaded = await p.download('linux-arm64');
  expect(downloaded).toMatchObject({ target: 'linux-arm64', fingerprint: manifest.fingerprint });
  expect(downloaded.archive).toEqual(fs.readFileSync(path.join(payloadDir, 'lush-remote-linux-arm64.tar.gz')));
  expect(calls.map(c => c.url.split('/').at(-1))).toEqual(['manifest.json', 'lush-remote-linux-arm64.tar.gz']);
  for (const c of calls) {
    expect(c.url).toContain(`/releases/download/payload-v0.2.0-${manifest.fingerprint}/`);
    expect(c.options.credentials).toBe('omit'); expect(c.options.redirect).toBe('manual');
    expect(c.options.headers.Authorization).toBeUndefined();
  }
  expect(fs.readdirSync(cache('linux-arm64')).sort()).toEqual(['lush-remote-linux-arm64.tar.gz', 'manifest.json']);
  const offline = provider({ fetchImpl: () => { throw new Error('must not fetch'); } });
  expect(offline.resolve('linux-arm64').download).toBeUndefined();
  expect((await offline.download('linux-arm64')).archiveSha256).toBe(downloaded.archiveSha256);
  expect(offline.resolve('linux-x64').download).toBeDefined();
  expect(fs.readdirSync(path.dirname(cache())).sort()).toEqual(['linux-arm64']);
});

test('matching bundled/manual payload wins, and stale local packages are preserved rather than installed', async () => {
  const p = provider({ payloadDir });
  expect(p.resolve('linux-x64').download).toBeUndefined();
  await p.download('linux-x64'); expect(calls).toHaveLength(0);
  const stale = provider({ payloadDir, identity: { lush_version: manifest.lush_version, fingerprint: '0000000000000000' } });
  expect(stale.resolve('linux-x64').download).toBeDefined();
  expect(JSON.parse(fs.readFileSync(path.join(payloadDir, 'manifest.json')))).toEqual(manifest);
  fs.appendFileSync(path.join(payloadDir, 'lush-remote-linux-x64.tar.gz'), 'corrupt');
  expect(() => p.resolve('linux-x64')).toThrow('checksum mismatch'); expect(calls).toHaveLength(0);
});

test('invalid publisher manifests reject before downloading an archive', async () => {
  for (const mutate of [
    m => { m.fingerprint = '0000000000000000'; },
    m => { m.targets['linux-x64'].file = '../evil.tar.gz'; },
    m => { m.targets['linux-x64'].bun_version = 'latest'; },
    m => { m.extra = true; },
    m => { delete m.targets['linux-x64']; },
  ]) {
    let fetched = 0;
    const m = structuredClone(manifest); mutate(m);
    const p = provider({ fetchImpl: () => { fetched++; return new Response(JSON.stringify(m)); } });
    await expect(p.download('linux-x64')).rejects.toThrow();
    expect(fetched).toBe(1); expect(fs.existsSync(cache())).toBe(false);
  }
});

test('corrupt downloaded archives never become cache entries and temporary files are removed', async () => {
  const p = provider({ fetchImpl: (url, options) => url.endsWith('manifest.json') ? asset(url, options) : new Response('corrupt archive') });
  await expect(p.download('linux-x64')).rejects.toThrow('checksum mismatch');
  expect(fs.existsSync(cache())).toBe(false);
  expect(fs.readdirSync(path.dirname(cache()))).toEqual([]);
});

test('valid downloaded hashes do not excuse actual runtime source identity mismatches', async () => {
  fs.appendFileSync(path.join(root, 'src/identity.js'), '// malicious source change');
  const badDir = path.join(root, 'bad-release');
  const bad = createRemotePayload(root, badDir, ['linux-x64']);
  const entry = bad.targets['linux-x64'], file = path.join(badDir, entry.file);
  const tar = gunzipSync(fs.readFileSync(file));
  const at = tar.indexOf(Buffer.from(bad.fingerprint)); expect(at).toBeGreaterThan(0);
  Buffer.from(manifest.fingerprint).copy(tar, at);
  const archive = gzipSync(tar); fs.writeFileSync(file, archive);
  bad.fingerprint = manifest.fingerprint;
  entry.sha256 = createHash('sha256').update(archive).digest('hex');
  fs.writeFileSync(path.join(badDir, 'manifest.json'), JSON.stringify(bad));
  const p = provider({ fetchImpl: url => new Response(fs.readFileSync(path.join(badDir, url.split('/').at(-1)))) });
  await expect(p.download('linux-x64')).rejects.toThrow('Runtime source identity mismatch');
  expect(fs.existsSync(cache())).toBe(false);
});

test('unpublished/private Releases fail clearly and never fall back to latest', async () => {
  const requested = [];
  const p = provider({ fetchImpl: url => { requested.push(url); return new Response('not public', { status: 404 }); } });
  await expect(p.download('linux-x64')).rejects.toThrow('尚未发布或不可公开访问');
  await expect(p.download('linux-x64')).rejects.toThrow('正式版本 tag');
  expect(requested).toHaveLength(2); expect(requested.every(url => !url.includes('/latest'))).toBe(true);
  expect(fs.existsSync(userData)).toBe(false);
});

test('downloads accept GitHub asset CDN redirects but refuse foreign, insecure or credentialed URLs', async () => {
  const good = provider({ fetchImpl: (url, options) => {
    calls.push({ url, options });
    if (new URL(url).hostname === 'github.com') return new Response(null, { status: 302, headers: { Location: `https://release-assets.githubusercontent.com/test/${url.split('/').at(-1)}` } });
    return new Response(fs.readFileSync(path.join(payloadDir, url.split('/').at(-1))));
  } });
  expect((await good.download('linux-x64')).fingerprint).toBe(manifest.fingerprint);
  expect(calls).toHaveLength(4);
  fs.rmSync(userData, { recursive: true });
  for (const location of ['http://127.0.0.1/evil', 'https://evil.example/evil', 'https://github.com/evil/repo/evil', 'https://user:secret@release-assets.githubusercontent.com/evil']) {
    let count = 0;
    const p = provider({ fetchImpl: () => { count++; return new Response(null, { status: 302, headers: { Location: location } }); } });
    await expect(p.download('linux-x64')).rejects.toThrow('非可信'); expect(count).toBe(1);
  }
});

test('manifest body/header limits and truncated responses fail before creating any cache', async () => {
  for (const response of [
    () => new Response('{}', { headers: { 'Content-Length': '17000' } }),
    () => new Response('x'.repeat(17000)),
    () => new Response('{}', { headers: { 'Content-Length': '123' } }),
  ]) {
    await expect(provider({ fetchImpl: response }).download('linux-x64')).rejects.toThrow();
    expect(fs.existsSync(userData)).toBe(false);
  }
});

test('cancellation aborts an in-flight download, hides transport errors and leaves no partial cache', async () => {
  const controller = new AbortController();
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  const p = provider({ fetchImpl: (url, options) => {
    if (url.endsWith('manifest.json')) return asset(url, options);
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('raw transport secret')), { once: true });
      started();
    });
  } });
  const pending = p.download('linux-x64', { signal: controller.signal }); pending.catch(() => {});
  await waiting; controller.abort();
  await expect(pending).rejects.toThrow('已取消'); expect(fs.existsSync(userData)).toBe(false);
  await expect(p.download('linux-x64', { signal: controller.signal })).rejects.toThrow('已取消');
  expect(calls).toHaveLength(1);
});

test('transport exceptions are fixed diagnostics, not raw response/auth details', async () => {
  const p = provider({ fetchImpl: () => { throw new Error('SECRET_TOKEN raw network response'); } });
  try { await p.download('linux-x64'); throw new Error('unexpected download success'); }
  catch (error) { expect(error.code).toBe('PAYLOAD_DOWNLOAD'); expect(error.message).not.toContain('SECRET_TOKEN'); }
  expect(fs.existsSync(userData)).toBe(false);
});

test.skipIf(process.platform === 'win32')('symlinked cache descendants are never followed or replaced', async () => {
  fs.mkdirSync(userData);
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'valuable');
  fs.symlinkSync(outside, path.join(userData, 'payload-cache'));
  await expect(provider().download('linux-x64')).rejects.toThrow('不安全');
  expect(calls).toHaveLength(0); expect(fs.readdirSync(outside)).toEqual(['keep']);
});
