/** One coordinator: the shell editor and active page have independent named protection slots.
 * Replacing a page guard cannot remove the shared input session's save protection.
 */
const guards = new Map();
let attempt = 0, revision = 0;
export function registerPageLeaveGuard(check, { stay = () => false, key = 'page' } = {}) {
  const entry = { check, stay, owner: globalThis.document }; guards.set(key, entry); revision++;
  return () => { if (guards.get(key) === entry) { guards.delete(key); revision++; attempt++; } };
}
export function resetPageLeaveGuard() { guards.clear(); revision++; attempt++; }
export function requestPageLeave(target, { leave = () => true, stay } = {}) {
  const token = ++attempt, version = revision, owner = globalThis.document;
  const { pathname, hash } = globalThis.location || {};
  const current = () => token === attempt && revision === version && owner === globalThis.document
    && pathname === globalThis.location?.pathname && hash === globalThis.location?.hash;
  // Save the editor before any page confirmation. Slots are bounded, not accumulated per visit.
  const entries = [...guards.entries()].sort(([a], [b]) => a === 'input-session' ? -1 : b === 'input-session' ? 1 : 0)
    .map(([, entry]) => entry).filter(entry => entry.owner === owner);
  function check(index) {
    if (!current()) return false;
    if (index === entries.length) return leave();
    const entry = entries[index], accepted = entry.check(target);
    const finish = ok => current() ? ok ? check(index + 1) : (stay || entry.stay)() : false;
    return accepted && typeof accepted.then === 'function' ? accepted.then(finish) : finish(accepted);
  }
  return check(0);
}
