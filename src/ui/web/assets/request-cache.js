/** One bounded, memory-only public read. No stale-on-error fallback or write retries. */
export function publicReadCache({ scope, load, ttl = 30_000, now = Date.now }) {
  let identity = null, entry = null;
  const abortError = () => new DOMException('只读请求已取消', 'AbortError');
  function invalidate() {
    const previous = entry; entry = null;
    previous?.controller?.abort();
  }
  function read({ signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    const next = scope();
    if (!identity || identity.project !== next.project || identity.boot !== next.boot) {
      invalidate(); identity = next;
    }
    if (entry?.ready && now() < entry.expires) return Promise.resolve(entry.value);
    if (entry?.ready) entry = null;
    if (!entry) {
      const controller = new AbortController();
      const pending = { controller, users: 0, ready: false };
      entry = pending;
      pending.promise = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw abortError();
        return load(controller.signal);
      }).then(value => {
        if (entry !== pending || controller.signal.aborted) throw abortError();
        const current = scope();
        if (current.project !== next.project || current.boot !== next.boot) { invalidate(); throw abortError(); }
        pending.ready = true; pending.value = value; pending.expires = now() + ttl;
        return value;
      }).catch(error => { if (entry === pending) entry = null; throw error; });
    }
    const pending = entry;
    pending.users++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, value) => {
        if (done) return; done = true;
        signal?.removeEventListener('abort', cancelled);
        pending.controller.signal.removeEventListener('abort', cancelled);
        pending.users--;
        fn(value);
        if (!pending.ready && pending.users === 0 && entry === pending) invalidate();
      };
      const cancelled = () => finish(reject, abortError());
      signal?.addEventListener('abort', cancelled, { once: true });
      pending.controller.signal.addEventListener('abort', cancelled, { once: true });
      pending.promise.then(value => finish(resolve, value), error => finish(reject, error));
    });
  }
  return { read, invalidate };
}
