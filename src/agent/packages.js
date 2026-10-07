import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { check, isPlainObject } from '../core/types.js';
import { ensurePiConfiguration, piConfigDirectory, readPiConfiguration } from './pi-config.js';
import { PI_CREDENTIAL_ENV_NAMES } from './status-accounts.js';
import { agentNetworkEnvironment } from './network.js';
import { scanDirectoryResources, scanPackageResources } from './resources.js';
import { normalizeConfigurationScope, scopedConfiguration, configurationScope, acquireConfigurationLock } from '../core/device-config.js';

/*
 * Lush-managed Pi package installation.
 *
 * Installs are declarations in the project-private Lush Pi directory (`<home>/pi/`), never in the
 * user's default Pi directory. The `pi` CLI is treated as a bounded, cancellable subprocess: no
 * shell, bounded stdout, no stderr passthrough, and a private environment that cannot redirect the
 * install root or leak provider credentials into package lifecycle scripts.
 *
 * Installation and enablement stay separate: a package is installed/pinned here and referenced by
 * absolute extension/skill paths from an Agent profile. Nothing in this module starts a model.
 */

const MAX_PACKAGES = 100;
const MAX_RESOURCES = 500;
const MAX_OUTPUT = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_SOURCE = 2048;
const ID_PATTERN = /^pkg-[0-9a-f]{16}$/;
const NPM_EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** A package subprocess failure whose code is safe to surface; diagnostics never cross an RPC. */
export class PackageCommandError extends Error {
  constructor(code) { super(`package command ${code}`); this.name = 'PackageCommandError'; this.code = code; }
}

export const PACKAGE_FAILURE_CODES = new Set(['cancelled', 'unavailable', 'timeout', 'output_too_large', 'failed']);

function npmSpecOf(source) {
  const spec = source.slice('npm:'.length).trim();
  const match = /^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/.exec(spec);
  return { name: match?.[1] ?? null, version: match?.[2] ?? null };
}

function isLocalSource(source) {
  return source.startsWith('/') || source.startsWith('./') || source.startsWith('../')
    || source.startsWith('~/') || source.startsWith('file://') || /^[A-Za-z]:[\\/]/.test(source);
}

function sourceKind(source) {
  if (source.startsWith('npm:')) return 'npm';
  if (source.startsWith('git:')) return 'git';
  if (/^(https?|ssh|git):\/\//i.test(source)) return 'git';
  if (source.startsWith('github:')) return 'unsupported';
  return isLocalSource(source) ? 'local' : 'unsupported';
}

/** Git ref pinned as `<repo>@ref` (or `#ref` for URLs); returns null for an unpinned remote. */
function gitRefOf(source) {
  const body = (source.startsWith('git:') ? source.slice(4) : source).trim();
  const scp = /^git@[^:]+:(.+)$/.exec(body);
  if (scp) {
    const rest = scp[1];
    const at = rest.lastIndexOf('@');
    return at > 0 && at < rest.length - 1 ? rest.slice(at + 1) : null;
  }
  if (body.includes('://')) {
    let url;
    try { url = new URL(body); } catch { return null; }
    if (url.hash.length > 1) return decodeURIComponent(url.hash.slice(1));
    const segments = url.pathname.split('/').filter(Boolean);
    const last = segments.pop() || '';
    const at = last.lastIndexOf('@');
    return at > 0 && at < last.length - 1 ? last.slice(at + 1) : null;
  }
  const slash = body.indexOf('/');
  if (slash < 0) return null;
  const hash = body.lastIndexOf('#');
  if (hash > slash) return body.slice(hash + 1) || null;
  const at = body.lastIndexOf('@');
  return at > slash && at < body.length - 1 ? body.slice(at + 1) : null;
}

/** Strict validation for an install request. Unpinned remote sources are refused before any network use. */
export function classifyPackageSource(raw) {
  check(typeof raw === 'string', 'package source must be text');
  const source = raw.trim();
  check(source.length > 0 && source.length <= MAX_SOURCE, `package source must be 1..${MAX_SOURCE} characters`);
  check(!/[\u0000-\u001f\u007f]/.test(source), 'package source contains control characters');
  const kind = sourceKind(source);
  if (kind === 'npm') {
    const { name, version } = npmSpecOf(source);
    check(name && NPM_EXACT.test(version ?? ''), 'npm packages must pin an exact version, for example npm:@scope/name@1.2.3');
    return { kind: 'npm', source, name, version, requested: version };
  }
  if (kind === 'git') {
    const ref = gitRefOf(source);
    check(ref, 'git packages must name an explicit ref (tag, branch or commit), for example git:github.com/owner/repo@v1');
    return { kind: 'git', source, ref, requested: ref };
  }
  check(kind === 'local',
    'unsupported package source; use npm:@scope/name@1.2.3, git:owner/repo@tag, or an explicit ./ or absolute local path');
  return { kind: 'local', source, requested: null };
}

/** Lenient description used for listing: a manually edited entry must not break the whole view. */
function describeSource(source) {
  const kind = sourceKind(source);
  if (kind === 'npm') { const { name, version } = npmSpecOf(source); return { kind, name, version, requested: version }; }
  if (kind === 'git') { const ref = gitRefOf(source); return { kind, ref, requested: ref }; }
  return { kind: kind === 'local' ? 'local' : 'unknown', requested: null };
}

function expandLocal(source) {
  let file = source;
  if (file.startsWith('file://')) {
    try { file = fileURLToPath(file); } catch { return null; }
  }
  if (file === '~' || file.startsWith('~/')) file = path.join(os.homedir(), file.slice(file === '~' ? 1 : 2));
  return file;
}

/** Canonical install source. Local paths become absolute so Pi never resolves them from the daemon cwd. */
export function normalizePackageSource(rawSource, options = {}) {
  const base = options.project || process.cwd();
  const parsed = classifyPackageSource(rawSource);
  if (parsed.kind !== 'local') return { ...parsed, install: parsed.source };
  const file = expandLocal(parsed.source);
  check(file, 'invalid local package path');
  const absolute = path.resolve(base, file);
  let real, stat;
  try { real = fs.realpathSync(absolute); } catch { check(false, 'local package path does not exist'); }
  try { stat = fs.statSync(real); } catch { check(false, 'local package path is not readable'); }
  check(stat.isDirectory(), 'local package source must be a directory');
  return { ...parsed, source: real, path: real, install: real };
}

function gitRepoParts(source) {
  const body = (source.startsWith('git:') ? source.slice(4) : source).trim();
  const scp = /^git@([^:]+):(.+)$/.exec(body);
  let host, repoPath;
  if (scp) { [, host, repoPath] = scp; }
  else {
    let url = null;
    try { url = new URL(body); } catch { url = null; }
    if (url) { host = url.hostname; repoPath = url.pathname; }
    else {
      const slash = body.indexOf('/');
      if (slash < 0) return null;
      host = body.slice(0, slash); repoPath = body.slice(slash + 1);
    }
  }
  repoPath = repoPath.replace(/^\/+/, '').replace(/\.git$/, '');
  const at = repoPath.lastIndexOf('@');
  if (at > 0) repoPath = repoPath.slice(0, at);
  if (!host || !repoPath || repoPath.split('/').some(part => part === '..')) return null;
  return { host, path: repoPath };
}

/** Best-effort install location when `pi list` is unavailable; only used to label local resources. */
function inferRoot(dir, source, described) {
  if (described.kind === 'local') { const file = expandLocal(source); return file ? path.resolve(dir, file) : null; }
  if (described.kind === 'npm' && described.name) return path.join(dir, 'npm', 'node_modules', described.name);
  if (described.kind === 'git') { const parts = gitRepoParts(source); if (parts) return path.join(dir, 'git', parts.host, parts.path); }
  return null;
}

function packageId(kind, identity) {
  return `pkg-${createHash('sha256').update(`${kind}\u0000${identity}`).digest('hex').slice(0, 16)}`;
}

function configuredPackages(settings) {
  const rows = [];
  const list = Array.isArray(settings.packages) ? settings.packages.slice(0, MAX_PACKAGES) : [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      const source = entry.trim();
      if (source) rows.push({ source, filtered: false, autoload: true });
      continue;
    }
    if (isPlainObject(entry) && typeof entry.source === 'string' && entry.source.trim()) {
      rows.push({ source: entry.source.trim(), filtered: true, autoload: entry.autoload !== false });
    }
  }
  return rows;
}

/** Parse `pi list` output: two-space source lines, four-space installed-root lines. */
export function parseInstalledPackages(output) {
  const rows = [];
  let inUser = false, current = null;
  for (const line of output.split(/\r?\n/)) {
    if (/^User packages:\s*$/.test(line)) { inUser = true; current = null; continue; }
    if (/^\S.*:\s*$/.test(line)) { inUser = false; current = null; continue; }
    if (!inUser) continue;
    const source = /^ {2}(\S.*)$/.exec(line);
    if (source) {
      current = { source: source[1].replace(/\s+\(filtered\)$/, '').trim(), root: null };
      if (current.source) rows.push(current); else current = null;
      continue;
    }
    const root = /^ {4}(\S.*)$/.exec(line);
    if (root && current) { current.root = root[1].trim(); continue; }
  }
  return rows;
}

function existsDirectory(root) {
  if (!root) return false;
  try { return fs.statSync(root).isDirectory(); } catch { return false; }
}

function installedVersion(root) {
  try {
    const file = path.join(root, 'package.json');
    if (fs.statSync(file).size > 64 * 1024) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof value?.version === 'string' && value.version.length <= 64 ? value.version : null;
  } catch { return null; }
}

function resourceRow(row, kind, packageIdValue) {
  const prefix = `${row.source} · `;
  const label = row.label?.startsWith(prefix) ? row.label.slice(prefix.length) : row.label;
  return { name: label || path.basename(row.id), path: row.id, kind,
    source: row.source, ...(row.description ? { description: row.description } : {}),
    ...(packageIdValue ? { package_id: packageIdValue } : {}) };
}

function appendResources(target, key, rows, packageIdValue) {
  for (const row of rows) {
    if (target[key].length >= MAX_RESOURCES) { target.truncated = true; continue; }
    target[key].push(resourceRow(row, key === 'extensions' ? 'extension' : 'skill', packageIdValue));
  }
}

/** Private subprocess environment: project network policy, private Pi directory, no ambient auth, no redirection. */
export function packageEnvironment(config) {
  const env = { ...agentNetworkEnvironment(config) };
  for (const key of Object.keys(env)) {
    if (key.startsWith('PI_')) { delete env[key]; continue; }
    if (PI_CREDENTIAL_ENV_NAMES.has(key)) delete env[key];
  }
  return { ...env, PI_CODING_AGENT_DIR: piConfigDirectory(config),
    PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', NO_COLOR: '1' };
}

/** Spawn without a shell; bounded output, group kill on timeout/cancel, stderr never captured or returned. */
export function spawnPackageCommand({ command, args, env, cwd, signal, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_OUTPUT }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new PackageCommandError('cancelled'));
    let child;
    try { child = cp.spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return reject(new PackageCommandError('unavailable')); }
    let stdout = '', bytes = 0, settled = false, timedOut = false, overflow = false;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } };
    const onAbort = () => kill();
    const timer = setTimeout(() => { timedOut = true; kill(); }, Math.max(1, timeoutMs));
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const settle = error => {
      if (settled) return;
      settled = true; cleanup();
      if (error) reject(error); else resolve(stdout);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) { overflow = true; kill(); return; }
      stdout += chunk;
    });
    child.on('error', () => settle(new PackageCommandError('unavailable')));
    child.on('close', code => {
      if (settled) return;
      if (signal?.aborted) return settle(new PackageCommandError('cancelled'));
      if (timedOut) return settle(new PackageCommandError('timeout'));
      if (overflow) return settle(new PackageCommandError('output_too_large'));
      if (code !== 0) return settle(new PackageCommandError('failed'));
      settle(null);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** Project-owned package manager for the Lush Pi directory. */
export class AgentPackages {
  constructor(config, options = {}) {
    check(config && typeof config === 'object', 'agent packages requires project configuration');
    this.originalConfig = config; this.scope = normalizeConfigurationScope(options.scope);
    this.config = this.scope === 'device' ? scopedConfiguration(config, this.scope) : config;
    this.options = options; this.scopedManagers = new Map();
    this.run = options.run || spawnPackageCommand;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxMutations = options.maxMutations ?? 8;
    this.pending = new Set();
    this.inflight = new Set();
    this.closed = false;
    this.mutations = [];
    this.activeMutation = null;
  }

  forScope(scope = 'project') {
    normalizeConfigurationScope(scope); this.assertOpen();
    if (scope === this.scope) return this;
    if (!this.scopedManagers.has(scope)) this.scopedManagers.set(scope, new AgentPackages(this.originalConfig, { ...this.options, scope }));
    return this.scopedManagers.get(scope);
  }

  directory() { return piConfigDirectory(this.config); }
  command() { return this.config.env.LUSH_PI_COMMAND || 'pi'; }

  async invoke(args, options = {}) {
    this.assertOpen();
    const controller = new AbortController();
    const relay = () => controller.abort();
    const signal = options.signal;
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', relay, { once: true });
    }
    const env = packageEnvironment(this.config);
    // Reading installed state stays local; only install/remove/update may use the network.
    if (options.offline) env.PI_OFFLINE = '1';
    this.pending.add(controller);
    const promise = Promise.resolve().then(() => this.run({ command: this.command(), args, cwd: this.scope === 'device' ? this.config.home : this.config.project || this.config.home,
      env, signal: controller.signal, timeoutMs: this.timeoutMs })).finally(() => {
      this.pending.delete(controller); this.inflight.delete(promise);
      if (signal) signal.removeEventListener('abort', relay);
    });
    this.inflight.add(promise);
    return promise;
  }

  /** Abort every in-flight install/remove/update, cancel queued mutations, wait for process groups. */
  async stop() {
    this.closed = true;
    const active = this.activeMutation;
    for (const controller of this.pending) controller.abort();
    await Promise.allSettled([...this.inflight, ...[...this.scopedManagers.values()].map(manager => manager.stop())]);
    if (active) await active;
  }

  isBusy() {
    return Boolean(this.activeMutation || this.pending.size || this.inflight.size || this.mutations.length
      || [...this.scopedManagers.values()].some(manager => manager.isBusy()));
  }

  assertOpen() { check(!this.closed, 'package management is stopping; retry after restart'); }

  /** Bounded serial queue: mutations never overlap, and a stopped manager never starts queued work. */
  async enqueueMutation(fn, options = {}) {
    this.assertOpen();
    check(this.mutations.length < this.maxMutations, 'too many pending package operations; retry after the current one');
    const signal = options.signal;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new PackageCommandError('cancelled')); return; }
      this.mutations.push({ fn, signal, resolve, reject });
      if (!this.activeMutation) this.activeMutation = this.drainMutations();
    });
  }

  async drainMutations() {
    while (this.mutations.length) {
      const task = this.mutations.shift();
      if (this.closed || task.signal?.aborted) { task.reject(new PackageCommandError('cancelled')); continue; }
      let lock;
      try {
        // Actual storage root: two daemons editing the shared library must never overlap.
        lock = acquireConfigurationLock(this.config, 'project', 'packages');
        const value = await task.fn(task.signal); lock.assert(); task.resolve(value);
      } catch (error) { task.reject(error); }
      finally { if (lock) { try { lock.release(); } catch { /* Do not remove a replaced lock. */ } } }
    }
    this.activeMutation = null;
  }

  async snapshot(signal) {
    this.assertOpen();
    const dir = this.directory();
    const settings = readPiConfiguration(path.join(dir, 'settings.json'));
    const configured = configuredPackages(settings);
    const resources = { extensions: [], skills: [] };
    const packages = [];
    let warning = null, listed = null;
    if (configured.length) {
      try { listed = parseInstalledPackages(await this.invoke(['list', '--no-approve'], { signal, offline: true })); }
      catch (error) {
        if (error instanceof PackageCommandError && error.code === 'cancelled') throw error;
        warning = '无法读取 Pi 已安装包的位置，仅显示配置声明；安装或更新后会重新读取。';
      }
    }
    const roots = new Map((listed || []).map(row => [row.source, row.root]));
    for (const entry of configured) {
      const described = describeSource(entry.source);
      const root = roots.get(entry.source) || inferRoot(dir, entry.source, described) || null;
      const installed = existsDirectory(root);
      // Canonical source: an absolute path for local packages so the value is reusable as an install input.
      const canonical = described.kind === 'local' ? (root || entry.source) : entry.source;
      const record = {
        id: packageId(described.kind, canonical),
        source: canonical,
        configured: entry.source,
        kind: described.kind,
        installed,
        root: root || null,
        filtered: entry.filtered,
        autoload: entry.autoload,
        requested: described.requested ?? null,
        version: installed ? installedVersion(root) : null,
      };
      const counts = { extensions: 0, skills: 0 };
      if (installed) {
        const found = scanPackageResources(root, { id: record.id, source: entry.source });
        appendResources(resources, 'extensions', found.extensions, record.id);
        appendResources(resources, 'skills', found.skills, record.id);
        counts.extensions = found.extensions.length; counts.skills = found.skills.length;
      }
      record.resource_counts = counts;
      packages.push(record);
    }
    // User-placed resources in the private Lush Pi directory itself, alongside installed packages.
    appendResources(resources, 'extensions', scanDirectoryResources(path.join(dir, 'extensions'), 'extension', 'Lush Pi'), null);
    appendResources(resources, 'skills', scanDirectoryResources(path.join(dir, 'skills'), 'skill', 'Lush Pi'), null);
    const order = (a, b) => a.source.localeCompare(b.source) || a.path.localeCompare(b.path);
    resources.extensions.sort(order); resources.skills.sort(order);
    return { version: 1, packages, resources, truncated: Boolean(resources.truncated), ...(warning ? { warning } : {}),
      ...(this.originalConfig.deviceHome ? { configuration_scope: configurationScope(this.originalConfig, this.scope, this.scope,
        this.scope === 'project' && configured.length > 0) } : {}) };
  }

  async list(options = {}) { return this.snapshot(options.signal); }

  install(rawSource, options = {}) {
    return this.enqueueMutation(async signal => {
      ensurePiConfiguration(this.config);
      const parsed = normalizePackageSource(rawSource, { project: this.config.project || this.config.home });
      await this.invoke(['install', parsed.install, '--no-approve'], { signal });
      return { ...(await this.snapshot(signal)), action: 'install' };
    }, options);
  }

  async resolve(rawId, signal) {
    check(typeof rawId === 'string' && ID_PATTERN.test(rawId.trim()), 'invalid package id');
    const { packages } = await this.snapshot(signal);
    const found = packages.find(item => item.id === rawId.trim());
    check(found, 'package not found; refresh the list and retry');
    const target = found.kind === 'local' ? found.root : found.source;
    check(target, 'package location is unknown; reinstall it to manage it from Lush');
    return found;
  }

  remove(rawId, options = {}) {
    return this.enqueueMutation(async signal => {
      ensurePiConfiguration(this.config);
      const found = await this.resolve(rawId, signal);
      const target = found.kind === 'local' ? found.root : found.source;
      await this.invoke(['remove', target, '--no-approve'], { signal });
      return { ...(await this.snapshot(signal)), action: 'remove' };
    }, options);
  }

  update(rawId, options = {}) {
    return this.enqueueMutation(async signal => {
      ensurePiConfiguration(this.config);
      const found = await this.resolve(rawId, signal);
      // A manually configured remote without an explicit ref must never be followed implicitly.
      classifyPackageSource(found.source);
      const target = found.kind === 'local' ? found.root : found.source;
      await this.invoke(['update', target, '--no-approve'], { signal });
      return { ...(await this.snapshot(signal)), action: 'update' };
    }, options);
  }
}
