/** Minimal POSIX shell formatting, used to print runnable commands (dry runs). */
const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Quote one argument so the printed line can be pasted into a POSIX shell. */
export function shellQuote(value) {
  const raw = String(value);
  if (raw === '') return "''";
  return SAFE.test(raw) ? raw : `'${raw.replaceAll("'", `'\\''`)}'`;
}

/** Join an argv array into one shell command line. */
export function shellCommand(argv) {
  return argv.map(shellQuote).join(' ');
}

/** Render `{ KEY: value }` as `KEY=value` shell assignments. */
export function shellEnv(env) {
  return Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ');
}
