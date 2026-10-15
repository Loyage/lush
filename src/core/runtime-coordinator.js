// Internal scheduling budget, not a business policy or a retry interval.
const BATCH_SIZE = 32;

/** Coalesces check requests only; handlers retain all authorization and execution state. */
export class RuntimeCoordinator {
  #handlers;
  #canRun;
  #onError;
  #pending = new Set();
  #ready = new Set();
  #running = new Set();
  #scheduled = null;
  #draining = false;
  #stopped = false;
  #stopPromise;
  #resolveStop;

  constructor(handlers, { canRun = () => true, onError = () => {} } = {}) {
    if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers)) {
      throw new TypeError('RuntimeCoordinator handlers must be an object');
    }
    this.#handlers = new Map(Object.entries(handlers));
    for (const [name, handler] of this.#handlers) {
      if (typeof handler !== 'function') throw new TypeError(`Invalid runtime handler: ${name}`);
    }
    if (typeof canRun !== 'function' || typeof onError !== 'function') {
      throw new TypeError('RuntimeCoordinator canRun and onError must be functions');
    }
    this.#canRun = canRun;
    this.#onError = onError;
  }

  get pendingCount() { return this.#pending.size; }
  get runningCount() { return this.#running.size; }

  request(name) {
    if (!this.#handlers.has(name)) throw new Error(`Unknown runtime handler: ${String(name)}`);
    if (this.#stopped || !this.#canRun()) return;
    this.#pending.add(name);
    // A dirty, running key stays pending but must not drive scheduling until it exits.
    if (!this.#running.has(name)) this.#ready.add(name);
    this.#schedule(false);
  }

  stop() {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopped = true;
    this.#clearPending();
    if (this.#scheduled?.kind === 'immediate') clearImmediate(this.#scheduled.handle);
    // Microtasks cannot be cancelled; invalidating their ticket makes them harmless.
    this.#scheduled = null;
    this.#stopPromise = new Promise(resolve => { this.#resolveStop = resolve; });
    if (!this.#running.size) this.#resolveStop();
    return this.#stopPromise;
  }

  #clearPending() {
    this.#pending.clear();
    this.#ready.clear();
  }

  #schedule(yieldToLoop) {
    if (this.#stopped || this.#draining || this.#scheduled || !this.#ready.size) return;
    // Closed admission drops checks, not execution results. Reopening needs a fresh request.
    if (!this.#canRun()) {
      this.#clearPending();
      return;
    }
    const ticket = { kind: yieldToLoop ? 'immediate' : 'microtask' };
    this.#scheduled = ticket;
    const drain = () => {
      if (this.#scheduled !== ticket) return;
      this.#scheduled = null;
      this.#drain();
    };
    if (yieldToLoop) ticket.handle = setImmediate(drain);
    else queueMicrotask(drain);
  }

  #drain() {
    this.#draining = true;
    try {
      for (let count = 0; count < BATCH_SIZE && !this.#stopped && this.#ready.size; count++) {
        if (!this.#canRun()) {
          this.#clearPending();
          break;
        }
        const name = this.#ready.values().next().value;
        this.#ready.delete(name);
        this.#pending.delete(name);
        // Mark running before calling user code, including synchronous reentrant requests/stop.
        this.#running.add(name);
        try {
          const result = this.#handlers.get(name)();
          Promise.resolve(result).then(
            () => this.#finish(name),
            error => { this.#report(name, error); this.#finish(name); },
          );
        } catch (error) {
          this.#report(name, error);
          this.#finish(name);
        }
      }
    } finally {
      this.#draining = false;
      this.#schedule(true);
    }
  }

  #report(name, error) {
    try {
      // Reporting is best-effort and must not strand handlers, even for an async reporter.
      Promise.resolve(this.#onError(name, error)).catch(() => {});
    } catch {}
  }

  #finish(name) {
    this.#running.delete(name);
    if (this.#stopped) {
      if (!this.#running.size) this.#resolveStop();
      return;
    }
    if (this.#pending.has(name)) this.#ready.add(name);
    // Even immediately settled/self-waking handlers must yield rather than form a microtask loop.
    this.#schedule(true);
  }
}
