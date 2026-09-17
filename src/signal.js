/**
 * Shutdown signal with two phases, so the daemon never tears the socket down
 * before the `system.shutdown` reply has been written.
 *
 * request(): a handler asked for shutdown (no teardown yet)
 * set():     the RPC server finished writing the reply; the daemon may proceed
 */
export function createSignal() {
  let resolve;
  let requested = false;
  let set = false;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return {
    promise,
    isRequested: () => requested,
    request: () => {
      requested = true;
    },
    isSet: () => set,
    set: () => {
      if (set) return;
      set = true;
      resolve();
    },
  };
}
