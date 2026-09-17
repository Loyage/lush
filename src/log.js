/**
 * Minimal stderr logger. The daemon's stdout/stderr are redirected into
 * `$LUSH_HOME/daemon.log` by the CLI, so stderr is the log channel.
 */
function stamp() {
  const d = new Date();
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function render(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const LEVELS = { debug: 'DEBUG', info: 'INFO', warn: 'WARNING', error: 'ERROR' };

export function createLogger(name) {
  const write = (level, args) => {
    const body = args.map(render).join(' ');
    process.stderr.write(`${stamp()} ${LEVELS[level]} ${name} ${body}\n`);
  };
  // Returned as a mutable object so tests can install spies.
  return {
    name,
    debug: (...args) => write('debug', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
    exception: (...args) => write('error', args),
  };
}
