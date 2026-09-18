import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_ORPHAN_POLICY, ORPHAN_ADOPT_MODES, normalizeOrphanPolicy } from './core/orphans.js';

/**
 * One non-negative number from the environment; `undefined` keeps the default.
 * `integer` is set for the settings the policy stores as integer seconds.
 */
function orphanEnvNumber(env, name, { integer = false } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number.parseFloat(raw);
  const kind = integer ? 'non-negative integer' : 'non-negative number of seconds';
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`invalid ${name}: ${raw} (choose a ${kind})`);
  }
  return value;
}

/**
 * Orphan supervision settings, read once at daemon startup (changing them needs
 * a restart). Each variable is validated on its own so the error names the one
 * to fix, then the whole policy goes through the core validator.
 */
function orphanPolicyFromEnv(env) {
  const policy = { ...DEFAULT_ORPHAN_POLICY };
  const adopt = env.LUSH_ORPHAN_ADOPT;
  if (adopt !== undefined && adopt !== '') {
    if (!ORPHAN_ADOPT_MODES.includes(adopt)) {
      throw new Error(`invalid LUSH_ORPHAN_ADOPT: ${adopt} (choose ${ORPHAN_ADOPT_MODES.join(', ')})`);
    }
    policy.adopt = adopt;
  }
  const limit = orphanEnvNumber(env, 'LUSH_ORPHAN_LIMIT', { integer: true });
  if (limit !== undefined) policy.limit = limit;
  const ttlSeconds = orphanEnvNumber(env, 'LUSH_ORPHAN_TTL');
  if (ttlSeconds !== undefined) policy.ttlSeconds = ttlSeconds;
  const sweepSeconds = orphanEnvNumber(env, 'LUSH_ORPHAN_SWEEP', { integer: true });
  if (sweepSeconds !== undefined) policy.sweepSeconds = sweepSeconds;
  return normalizeOrphanPolicy(policy);
}

/** Runtime configuration, read from the environment by the daemon at startup. */
export class Config {
  constructor({ home, provider = 'pi', callTimeout = 900, maxRounds = 12, orphanPolicy = DEFAULT_ORPHAN_POLICY }) {
    this.home = home;
    /**
     * The provider the *environment* selects (`LUSH_PROVIDER`, default `pi`).
     * This is the fallback tier only: `lush agent` profiles can select a
     * different backend per process, and `src/agent/profiles.js` adds the
     * built-in `default` profile (pure pi) as the last tier after this one.
     */
    this.provider = provider;
    this.callTimeout = callTimeout;
    this.maxRounds = maxRounds;
    // PID 0's supervision policy (camelCase), normalized once so the daemon can
    // trust `limit` / `ttlSeconds` / `sweepSeconds` without re-validating.
    this.orphanPolicy = normalizeOrphanPolicy(orphanPolicy);
  }

  get socket() {
    return path.join(this.home, 'lush.sock');
  }

  static fromEnv(env = process.env) {
    const base = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
    let home = env.LUSH_HOME || path.join(base, 'lush');
    if (home === '~' || home.startsWith('~/')) home = path.join(os.homedir(), home.slice(1));
    home = path.resolve(home);

    const timeout = Number.parseFloat(env.LUSH_CALL_TIMEOUT ?? '900');
    const rounds = Number.parseInt(env.LUSH_MAX_ROUNDS ?? '12', 10);
    if (!Number.isFinite(timeout) || !(timeout > 0 && timeout <= 86_400)
      || !Number.isInteger(rounds) || !(rounds >= 1 && rounds <= 100)) {
      throw new Error('invalid LUSH_CALL_TIMEOUT or LUSH_MAX_ROUNDS');
    }
    return new Config({
      home,
      provider: env.LUSH_PROVIDER || 'pi',
      callTimeout: timeout,
      maxRounds: rounds,
      orphanPolicy: orphanPolicyFromEnv(env),
    });
  }

  prepare() {
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    if (fs.statSync(this.home).uid !== process.getuid()) {
      throw new Error('LUSH_HOME must belong to the current user');
    }
    fs.chmodSync(this.home, 0o700);
    if (Buffer.byteLength(this.socket) > 103) {
      throw new Error('Unix socket path is too long; choose a shorter LUSH_HOME');
    }
  }
}
