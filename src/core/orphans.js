/**
 * SID 0 orphan supervision.
 *
 * An orphan is a service SID 0 adopted when its parent entered a terminal
 * state: `parent_sid = 0`, `sid > 0` and a non-zero `original_parent_sid`.
 * Services SID 0 created itself are not orphans and are never supervised.
 *
 * This module is pure policy plus read model: it decides *which* orphan is
 * due, and every state change goes through `ServiceManager.orphanEvict`
 * (freezing, never deleting — metadata, Context, messages, calls and events
 * all survive; only `delete` / `purge` remove rows).
 */
import { LushError } from './types.js';

/** What happens to active direct children when their parent reaches a terminal state. */
export const ORPHAN_ADOPT_MODES = ['adopt', 'none', 'terminate'];

/** Who asked for a supervision pass: a person, the daemon timer, or an adoption. */
export const ORPHAN_TRIGGERS = ['manual', 'timer', 'adoption'];

/** Defaults reproduce the pre-supervision behaviour: adopt everything, no limit, no TTL. */
export const DEFAULT_ORPHAN_POLICY = { adopt: 'adopt', limit: 0, ttlSeconds: 0, sweepSeconds: 30 };

function nonNegativeNumber(value, message) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new LushError(message, -32602);
  }
  return value;
}

/**
 * Validate a (possibly partial) orphan policy and fill the missing fields from
 * `DEFAULT_ORPHAN_POLICY`. Internal shape is camelCase; unknown keys are
 * ignored so a wire report (`ttl_seconds`, `sweep_seconds`) can be fed back in
 * without renaming. Invalid values are `-32602` and name the offending field.
 */
export function normalizeOrphanPolicy(policy = {}) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new LushError('orphan policy must be an object', -32602);
  }
  const merged = { ...DEFAULT_ORPHAN_POLICY, ...policy };
  if (!ORPHAN_ADOPT_MODES.includes(merged.adopt)) {
    throw new LushError(`orphan adopt mode must be one of ${ORPHAN_ADOPT_MODES.join(', ')}`, -32602);
  }
  const limit = nonNegativeNumber(merged.limit, 'orphan limit must be a non-negative integer');
  if (!Number.isInteger(limit)) throw new LushError('orphan limit must be a non-negative integer', -32602);
  const ttlSeconds = nonNegativeNumber(merged.ttlSeconds, 'orphan ttl must be a non-negative number of seconds');
  const sweepSeconds = nonNegativeNumber(
    merged.sweepSeconds,
    'orphan sweep must be a non-negative integer number of seconds',
  );
  if (!Number.isInteger(sweepSeconds)) {
    throw new LushError('orphan sweep must be a non-negative integer number of seconds', -32602);
  }
  return { adopt: merged.adopt, limit, ttlSeconds, sweepSeconds };
}

/** Milliseconds since epoch for an ISO timestamp, or `null` when unreadable. */
function stamp(value) {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The orphan pool of SID 0: a read model over `repository.orphans()`, with the
 * runtime facts (busy, idle) the supervision rules need. Nothing here writes.
 */
export class OrphanSupervisor {
  constructor(repository, manager, policy = DEFAULT_ORPHAN_POLICY) {
    this.repository = repository;
    this.manager = manager;
    this._policy = normalizeOrphanPolicy(policy);
    /** Overridable for tests: `manager.orphanSupervisor.clock = () => fixed`. */
    this.clock = () => Date.now();
    /** Reentrancy guard: one supervision pass at a time. */
    this.running = false;
  }

  get policy() {
    return { ...this._policy };
  }

  /** Wire (snake_case) policy, as shown by `service.orphans` and `system.status`. */
  policyReport() {
    return {
      adopt: this._policy.adopt,
      limit: this._policy.limit,
      ttl_seconds: this._policy.ttlSeconds,
      sweep_seconds: this._policy.sweepSeconds,
    };
  }

  /** One orphan row: wire shape, JSON-safe, with `busy` / `idle_seconds` computed now. */
  _entry(row) {
    const stamps = [stamp(row.updated_at), stamp(row.last_message_at), stamp(row.last_call_at)]
      .filter((value) => value !== null);
    // `updated_at` always exists, so a row normally has an activity stamp; an
    // unreadable one degrades to "active right now" instead of a bogus age.
    const lastActivity = stamps.length ? Math.max(...stamps) : this.clock();
    const idleMs = Math.max(0, this.clock() - lastActivity);
    return {
      sid: row.sid,
      name: row.name,
      status: row.status,
      template: row.template,
      original_parent_sid: row.original_parent_sid,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_activity_at: new Date(lastActivity).toISOString(),
      idle_seconds: Math.floor(idleMs / 1000),
      busy: this.manager.runtime?.isBusy(row.sid) ?? false,
    };
  }

  /**
   * SID 0's orphans (terminal ones included, so the read model can show what
   * was frozen), plus the counters the policy is expressed against.
   */
  pool() {
    const orphans = this.repository.orphans().map((row) => this._entry(row));
    const active = orphans.filter((orphan) => orphan.status === 'created' || orphan.status === 'active');
    const limit = this._policy.limit;
    return {
      policy: this.policyReport(),
      active_count: active.length,
      busy_count: orphans.filter((orphan) => orphan.busy).length,
      over_limit: limit > 0 ? Math.max(0, active.length - limit) : 0,
      orphans,
    };
  }

  /** Active orphans, oldest activity first (ties broken by sid) — the eviction order. */
  _candidates(pool) {
    return pool.orphans
      .filter((orphan) => orphan.status === 'created' || orphan.status === 'active')
      .sort((left, right) => (
        left.last_activity_at === right.last_activity_at
          ? left.sid - right.sid
          : (left.last_activity_at < right.last_activity_at ? -1 : 1)
      ));
  }

  /**
   * Run one supervision pass: freeze idle orphans past the TTL, then freeze the
   * oldest ones while SID 0 holds more active orphans than the limit allows.
   *
   * The pool is re-read after every eviction, because freezing a parent makes
   * its own active children orphans of SID 0 in turn. Busy orphans (an agent
   * call is running) are never frozen; when only busy ones remain, the limit
   * pass stops and reports them as `deferred`.
   *
   * The report counts what the pass examined: `checked` is every orphan row in
   * the pool (frozen ones included, they are part of the record), while
   * `active_before` / `active_after` are the orphans the policy could act on.
   */
  supervise({ trigger = 'manual' } = {}) {
    if (!ORPHAN_TRIGGERS.includes(trigger)) {
      throw new LushError(`orphan trigger must be one of ${ORPHAN_TRIGGERS.join(', ')}`, -32602);
    }
    let pool = this.pool();
    const report = {
      trigger,
      skipped: false,
      checked: pool.orphans.length,
      active_before: pool.active_count,
      active_after: pool.active_count,
      evicted: [],
      deferred: [],
      limit: this._policy.limit,
      ttl_seconds: this._policy.ttlSeconds,
    };
    // Reentrancy: an eviction inside a pass triggers the adoption hook again.
    if (this.running) return { ...report, skipped: true };
    this.running = true;
    try {
      const evict = (candidate, reason) => {
        const updated = this.manager.orphanEvict(candidate.sid, reason);
        report.evicted.push({
          sid: candidate.sid,
          name: candidate.name,
          from: candidate.status,
          to: updated.status,
          reason,
          idle_seconds: candidate.idle_seconds,
        });
        pool = this.pool();
      };
      const attempted = new Set();
      const next = (predicate) => {
        const candidate = this._candidates(pool).find((orphan) => !attempted.has(orphan.sid) && predicate(orphan));
        if (candidate) attempted.add(candidate.sid);
        return candidate;
      };

      while (this._policy.ttlSeconds > 0) {
        const candidate = next((orphan) => !orphan.busy && orphan.idle_seconds >= this._policy.ttlSeconds);
        if (!candidate) break;
        evict(candidate, 'orphan_ttl');
      }
      while (this._policy.limit > 0 && pool.active_count > this._policy.limit) {
        const candidate = next((orphan) => !orphan.busy);
        if (!candidate) {
          const blocked = this._candidates(pool).find((orphan) => !attempted.has(orphan.sid));
          if (blocked) report.deferred.push({ sid: blocked.sid, reason: 'busy' });
          break;
        }
        evict(candidate, 'orphan_limit');
      }
      report.active_after = pool.active_count;
      return report;
    } finally {
      this.running = false;
    }
  }
}
