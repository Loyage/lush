import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSSHManager } from '../ui/desktop/ssh.js';
import { readSSHConfig } from '../ui/desktop/ssh-config.js';
import { createReleasePayloadProvider, desktopReleaseIdentity } from '../ui/desktop/ssh-release.js';

const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const ENVIRONMENT_ID = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MAX_PLAN_BYTES = 64 * 1024;

function check(value, message) { if (!value) throw new Error(message); }

/** Public Web SSH is deny-by-default. This parser accepts aliases, never hosts, URLs or ssh argv. */
export function sshHostAllowlist(env = process.env) {
  if (env.LUSH_SSH_HOSTS === undefined) return null;
  let value;
  try { value = JSON.parse(env.LUSH_SSH_HOSTS); } catch { throw new Error('LUSH_SSH_HOSTS must be a JSON array of SSH Host aliases'); }
  check(Array.isArray(value) && value.length <= 256, 'LUSH_SSH_HOSTS must be a JSON array with at most 256 SSH Host aliases');
  const seen = new Set();
  for (const alias of value) {
    check(typeof alias === 'string' && ALIAS.test(alias), 'LUSH_SSH_HOSTS entries must be safe SSH Host aliases, not URLs, commands or arguments');
    check(!seen.has(alias), `LUSH_SSH_HOSTS contains duplicate alias: ${alias}`);
    seen.add(alias);
  }
  return [...seen];
}

function defaultManager(scope, env) {
  const userData = path.join(scope.home, 'environments');
  // Packaged macOS runs this Host from resources/local-runtime; reuse its
  // trusted sibling payload rather than ignoring the bundled Linux archives.
  const bundled = path.join(ROOT, '..', 'remote-payload');
  const payloadDir = path.basename(ROOT) === 'local-runtime' && fs.existsSync(path.join(bundled, 'manifest.json'))
    ? bundled : path.join(ROOT, 'node_modules/lush-remote-build/payload');
  const identity = desktopReleaseIdentity(ROOT);
  const payloadProvider = createReleasePayloadProvider({ payloadDir, userData, identity });
  return createSSHManager({ userData, payloadDir, payloadProvider, env });
}

function loopbackEndpoint(row) {
  check(row && row.connected === true && typeof row.id === 'string' && ENVIRONMENT_ID.test(row.id), '环境未连接或身份无效');
  let url;
  try { url = new URL(row.url); } catch { throw new Error('SSH 隧道入口无效'); }
  check(url.protocol === 'http:' && url.hostname === '127.0.0.1' && /^\d+$/.test(url.port)
    && Number(url.port) >= 1 && Number(url.port) <= 65535 && url.pathname === '/' && !url.search && !url.hash
    && !url.username && !url.password, 'SSH 隧道必须是已验证的 127.0.0.1 HTTP 入口');
  return url.origin;
}

/** Host-owned SSH access. Plans are kept only in memory and bound to the Web session that inspected them. */
export function createEnvironmentManager({ env = process.env, scope, publicAccess = false, sshManager, managerFactory = defaultManager,
  readConfig = readSSHConfig, hostname = os.hostname(), username, now = () => Date.now(), planTtlMs = 5 * 60_000 } = {}) {
  check(scope?.home, 'environment manager requires a Host configuration scope');
  const allowlist = sshHostAllowlist(env);
  const allowed = publicAccess ? new Set(allowlist || []) : null;
  let manager = sshManager || null, managerError = null;
  const supportedByPolicy = !publicAccess || allowlist !== null && allowlist.length > 0;
  if (!manager && supportedByPolicy) {
    try { manager = managerFactory(scope, env); } catch (error) { managerError = error; }
  }
  if (!username) {
    try { username = os.userInfo().username; } catch { username = env.USER || env.USERNAME || 'unknown'; }
  }
  const plans = new Map(), busyAliases = new Map();
  let disposed = false;
  const allowedAlias = alias => !allowed || allowed.has(alias);
  const live = () => check(!disposed, '环境管理器已关闭');
  const known = id => manager?.list().find(row => row.id === id) || null;

  function hosts() {
    if (allowed) return [...allowed].map(alias => ({ alias }));
    const result = readConfig({ home: env.HOME || os.homedir() });
    return { hosts: result.hosts.filter(row => ALIAS.test(row.alias)), warnings: result.warnings };
  }
  function status() {
    live();
    const configured = hosts();
    const hostRows = Array.isArray(configured) ? configured : configured.hosts;
    const warnings = Array.isArray(configured) ? [] : configured.warnings;
    if (managerError) warnings.push(`SSH 环境管理初始化失败：${managerError.message}`);
    const connections = manager ? manager.list().filter(row => allowedAlias(row.alias)).map(row => ({ id: row.id, alias: row.alias, connected: row.connected === true })) : [];
    const supported = Boolean(manager) && supportedByPolicy;
    return { execution: { hostname, username, scope: 'host' }, ssh: { supported,
      ...(!supported ? { reason: publicAccess && allowlist === null
        ? '公网 Web 未配置 LUSH_SSH_HOSTS；SSH 环境管理默认关闭。'
        : publicAccess && allowlist?.length === 0 ? 'LUSH_SSH_HOSTS 为空；未授权任何 SSH Host。'
        : managerError?.message || 'SSH 环境管理不可用。' } : {}),
      hosts: hostRows, warnings, connections } };
  }
  function requireManager() {
    live();
    check(manager && supportedByPolicy, 'SSH 环境管理未启用；公网需配置 LUSH_SSH_HOSTS');
  }
  function prunePlans() {
    for (const [session, entry] of plans) if (entry.phase === 'ready' && entry.expires <= now()) plans.delete(session);
  }
  function active(session, entry) {
    check(!disposed && !entry.cancelled && plans.get(session) === entry, 'SSH 操作已取消；请重新预检');
  }
  async function inspect(session, input) {
    requireManager(); prunePlans();
    check(typeof session === 'string' && session && session.length <= 128, '缺少环境会话身份');
    check(input && typeof input === 'object' && !Array.isArray(input)
      && Object.keys(input).every(key => ['alias', 'id'].includes(key))
      && typeof input.alias === 'string' && ALIAS.test(input.alias)
      && (input.id === undefined || typeof input.id === 'string' && ENVIRONMENT_ID.test(input.id)), 'SSH 预检只接受 alias 与可选 id');
    check(allowedAlias(input.alias), '此 SSH Host 未列入 LUSH_SSH_HOSTS 白名单');
    const previous = plans.get(session);
    check(!previous || previous.phase === 'ready', '当前会话已有 SSH 操作，请等待或取消');
    check(!busyAliases.has(input.alias), '此 SSH 环境正在操作，请等待完成或取消');
    check(plans.has(session) || plans.size < 1024, 'SSH 确认计划过多，请稍后重试');
    const current = { phase: 'inspecting', pending: input.id || input.alias, alias: input.alias, plan: null, cancelled: false };
    plans.set(session, current); busyAliases.set(input.alias, current);
    try {
    const result = await manager.inspect({ alias: input.alias, ...(input.id ? { id: input.id } : {}) });
    active(session, current);
    check(result?.profile?.id && ENVIRONMENT_ID.test(result.profile.id) && result.profile.alias === input.alias, 'SSH 预检返回了错误的环境身份');
    check(allowedAlias(result.profile.alias), '此 SSH Host 未列入 LUSH_SSH_HOSTS 白名单');
    const serialized = JSON.stringify({ plan: result.plan ?? {}, warnings: result.warnings ?? [] });
    check(Buffer.byteLength(serialized) <= MAX_PLAN_BYTES, 'SSH 安装计划超过安全大小限制');
    const details = JSON.parse(serialized), confirmation = randomUUID();
    const inspection = { profile: { id: result.profile.id, alias: result.profile.alias }, ready: result.ready === true,
      requiresInstall: result.requiresInstall === true, ...details };
    current.pending = result.profile.id; current.phase = 'ready'; current.expires = now() + planTtlMs;
    current.plan = inspection.ready || inspection.requiresInstall ? { ...inspection, confirmation } : null;
    return { ...inspection, confirmation: current.plan?.confirmation ?? null };
    } catch (error) {
      if (plans.get(session) === current) plans.delete(session);
      throw error;
    } finally {
      if (busyAliases.get(input.alias) === current) busyAliases.delete(input.alias);
    }
  }
  async function connect(session, input) {
    requireManager(); prunePlans();
    const entry = plans.get(session);
    const authorization = entry?.phase === 'ready' ? entry.plan : null;
    check(input && typeof input === 'object' && !Array.isArray(input)
      && Object.keys(input).every(key => ['confirmation', 'install'].includes(key))
      && typeof input.confirmation === 'string' && typeof input.install === 'boolean'
      && authorization && input.confirmation === authorization.confirmation,
    '请先在当前登录会话预检环境，再使用一次性确认连接');
    check(!busyAliases.has(authorization.profile.alias), '此 SSH 环境正在操作，请稍后重试');
    entry.plan = null; entry.phase = 'connecting'; // Consume authorization, retain cancellation ownership.
    busyAliases.set(authorization.profile.alias, entry);
    try {
      check(!authorization.requiresInstall || input.install, '首次安装需要明确确认安装计划');
      check(allowedAlias(authorization.profile.alias), '此 SSH Host 未列入 LUSH_SSH_HOSTS 白名单');
      const result = await manager.connect(authorization.profile, { install: authorization.requiresInstall && input.install });
      active(session, entry);
      check(result?.profile?.id === authorization.profile.id && result.profile.alias === authorization.profile.alias, 'SSH 连接返回了错误的环境身份');
      const row = known(result.profile.id);
      loopbackEndpoint(row);
      return { id: row.id, href: `/e/${row.id}/` };
    } catch (error) {
      // A late successful tunnel after cancellation must not become a usable endpoint.
      manager.disconnect(authorization.profile.id);
      throw error;
    } finally {
      if (plans.get(session) === entry) plans.delete(session);
      if (busyAliases.get(authorization.profile.alias) === entry) busyAliases.delete(authorization.profile.alias);
    }
  }
  function cancel(session) {
    live();
    const entry = plans.get(session);
    plans.delete(session);
    if (entry) {
      entry.cancelled = true;
      // Discarding a ready confirmation must not tear down a previously connected environment.
      if (entry.phase !== 'ready' && manager) manager.disconnect(entry.pending);
    }
    return { cancelled: true };
  }
  function disconnect(id) {
    requireManager();
    check(typeof id === 'string' && ENVIRONMENT_ID.test(id), '环境身份无效');
    const row = known(id);
    check(row && allowedAlias(row.alias), '未知或未授权的环境身份');
    manager.disconnect(id);
    for (const [session, entry] of plans) if (entry.pending === id || entry.alias === row.alias) { entry.cancelled = true; plans.delete(session); }
    return { id, connected: false };
  }
  function endpoint(id) {
    live(); check(typeof id === 'string' && ENVIRONMENT_ID.test(id), '环境身份无效');
    const row = known(id);
    check(row && allowedAlias(row.alias), '未知或未授权的环境身份');
    return loopbackEndpoint(row);
  }
  function describe(id) {
    live();
    const row = known(id);
    check(row && allowedAlias(row.alias), '未知或未授权的环境身份');
    return { id: row.id, alias: row.alias };
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const entry of plans.values()) entry.cancelled = true;
    plans.clear();
    manager?.dispose();
  }
  return { status, inspect, connect, cancel, disconnect, endpoint, describe, dispose };
}
