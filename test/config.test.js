import { describe, expect, test } from 'bun:test';
import { Config } from '../src/config.js';
import { DEFAULT_ORPHAN_POLICY } from '../src/core/orphans.js';

/** Minimal environment: only what `Config.fromEnv` reads. */
function env(overrides = {}) {
  return { LUSH_HOME: '/tmp/lush-config-test', ...overrides };
}

describe('config', () => {
  test('orphan policy defaults reproduce the pre-supervision behaviour', () => {
    const config = Config.fromEnv(env());
    expect(config.orphanPolicy).toEqual(DEFAULT_ORPHAN_POLICY);
    expect(config.orphanPolicy).toEqual({ adopt: 'adopt', limit: 0, ttlSeconds: 0, sweepSeconds: 30 });
    // Constructed directly (tests, embedded use) it is normalized just the same.
    expect(new Config({ home: '/tmp/x' }).orphanPolicy).toEqual(DEFAULT_ORPHAN_POLICY);
    expect(new Config({ home: '/tmp/x', orphanPolicy: { adopt: 'none' } }).orphanPolicy)
      .toEqual({ ...DEFAULT_ORPHAN_POLICY, adopt: 'none' });
  });

  test('orphan policy reads all four variables, ttl may be fractional', () => {
    const config = Config.fromEnv(env({
      LUSH_ORPHAN_ADOPT: 'terminate',
      LUSH_ORPHAN_LIMIT: '3',
      LUSH_ORPHAN_TTL: '0.5',
      LUSH_ORPHAN_SWEEP: '5',
    }));
    expect(config.orphanPolicy).toEqual({ adopt: 'terminate', limit: 3, ttlSeconds: 0.5, sweepSeconds: 5 });
    // Individual settings stay independent of each other.
    expect(Config.fromEnv(env({ LUSH_ORPHAN_LIMIT: '0' })).orphanPolicy.limit).toBe(0);
    expect(Config.fromEnv(env({ LUSH_ORPHAN_TTL: '60' })).orphanPolicy.ttlSeconds).toBe(60);
    expect(Config.fromEnv(env({ LUSH_ORPHAN_SWEEP: '0' })).orphanPolicy.sweepSeconds).toBe(0);
    // The rest of the config is untouched by the orphan settings.
    expect(config.provider).toBe('pi');
    expect(config.callTimeout).toBe(900);
    expect(config.maxRounds).toBe(12);
    expect(config.taskCalls).toBe(12);
  });

  test('the task call budget is configurable and validated', () => {
    expect(Config.fromEnv(env({ LUSH_TASK_CALLS: '3' })).taskCalls).toBe(3);
    for (const value of ['0', '-1', 'many', '101']) {
      expect(() => Config.fromEnv(env({ LUSH_TASK_CALLS: value }))).toThrow(/LUSH_TASK_CALLS/);
    }
  });

  test('invalid orphan settings name the variable to fix', () => {
    const rejected = [
      ['LUSH_ORPHAN_ADOPT', 'maybe', 'invalid LUSH_ORPHAN_ADOPT: maybe', 'adopt'],
      ['LUSH_ORPHAN_LIMIT', '-1', 'invalid LUSH_ORPHAN_LIMIT: -1', 'non-negative integer'],
      ['LUSH_ORPHAN_LIMIT', '2.5', 'invalid LUSH_ORPHAN_LIMIT: 2.5', 'non-negative integer'],
      ['LUSH_ORPHAN_LIMIT', 'many', 'invalid LUSH_ORPHAN_LIMIT: many', 'non-negative integer'],
      ['LUSH_ORPHAN_TTL', '-0.1', 'invalid LUSH_ORPHAN_TTL: -0.1', 'non-negative number'],
      ['LUSH_ORPHAN_TTL', 'soon', 'invalid LUSH_ORPHAN_TTL: soon', 'non-negative number'],
      ['LUSH_ORPHAN_SWEEP', '-5', 'invalid LUSH_ORPHAN_SWEEP: -5', 'non-negative integer'],
      ['LUSH_ORPHAN_SWEEP', '1.5', 'invalid LUSH_ORPHAN_SWEEP: 1.5', 'non-negative integer'],
    ];
    for (const [name, value, message, hint] of rejected) {
      let error = null;
      try {
        Config.fromEnv(env({ [name]: value }));
      } catch (err) {
        error = err;
      }
      expect(error, `${name}=${value} should be rejected`).not.toBeNull();
      expect(error.message).toContain(message);
      expect(error.message).toContain(hint);
    }
  });
});
