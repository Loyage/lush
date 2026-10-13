/** One active page may veto same-tab workspace/hash navigation. No guard affects new tabs. */
let guard = null, attempt = 0;
export function registerPageLeaveGuard(check, { stay = () => false } = {}) {
  const entry = { check, stay, owner: globalThis.document }; guard = entry;
  return () => { if (guard === entry) { guard = null; attempt++; } };
}
/** A new shell must never resume a confirmation from an earlier boot, even in the same document. */
export function resetPageLeaveGuard() { guard = null; attempt++; }

/** Preserve synchronous destination announcement unless the page actually needs confirmation.
 * Both acceptance and rejection belong to this attempt: a stale rejection must not restore an old
 * hash over a newer click/back navigation. Run the continuation inside the same ownership check.
 */
export function requestPageLeave(target, { leave = () => true, stay } = {}) {
  const entry = guard, token = ++attempt, owner = globalThis.document;
  const { pathname, hash } = globalThis.location || {};
  const finish = accepted => {
    if (token !== attempt || guard !== entry || owner !== globalThis.document
      || pathname !== globalThis.location?.pathname || hash !== globalThis.location?.hash) return false;
    return accepted ? leave() : (stay || entry?.stay || (() => false))();
  };
  const accepted = entry && entry.owner === owner ? entry.check(target) : true;
  return accepted && typeof accepted.then === 'function' ? accepted.then(finish) : finish(accepted);
}
