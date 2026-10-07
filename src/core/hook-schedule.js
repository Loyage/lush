import { check, isPlainObject } from './types.js';

const formatters = new Map();
function formatter(timezone) {
  let value = formatters.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, calendar: 'iso8601', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    if (formatters.size >= 64) formatters.delete(formatters.keys().next().value);
    formatters.set(timezone, value);
  }
  return value;
}
function localParts(timestamp, timezone) {
  return Object.fromEntries(formatter(timezone).formatToParts(new Date(timestamp))
    .filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}
function utc(parts) {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0, 0);
  return date.getTime();
}
function exactDate(at) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(at);
  if (!match) return false;
  const [, y, m, d, h, min, sec = '0', offset] = match;
  const date = new Date(utc({ year: +y, month: +m, day: +d }));
  return +y >= 1 && +m >= 1 && +m <= 12 && +d >= 1 && date.getUTCFullYear() === +y && date.getUTCMonth() === +m - 1
    && date.getUTCDate() === +d && +h <= 23 && +min <= 59 && +sec <= 59
    && (offset === 'Z' || (+offset.slice(1, 3) <= 23 && +offset.slice(4) <= 59)) && Number.isFinite(Date.parse(at));
}

/** Strict, credential-free configuration. A one-shot instant never uses the daemon's local zone. */
export function normalizeHookSchedule(value, mode) {
  check(isPlainObject(value), 'scheduled hook requires a schedule');
  check(typeof value.timezone === 'string' && value.timezone.length <= 100 && value.timezone.trim() === value.timezone
    && value.timezone.length > 0 && !/^[+-]/.test(value.timezone), 'invalid schedule timezone');
  try { formatter(value.timezone); } catch { check(false, 'invalid schedule timezone'); }
  if (value.kind === 'once') {
    check(Object.keys(value).every(k => ['kind', 'at', 'timezone'].includes(k)), 'invalid once schedule fields');
    check(mode === 'once', 'one-shot schedule requires once mode');
    check(typeof value.at === 'string' && exactDate(value.at), 'schedule at requires a valid ISO date with explicit offset or Z');
    return { kind: 'once', at: new Date(value.at).toISOString(), timezone: value.timezone };
  }
  check(value.kind === 'daily', 'schedule kind must be once or daily');
  check(Object.keys(value).every(k => ['kind', 'time', 'timezone'].includes(k)), 'invalid daily schedule fields');
  check(mode === 'persistent', 'daily schedule requires persistent mode');
  check(typeof value.time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time), 'schedule time must be HH:mm');
  return { kind: 'daily', time: value.time, timezone: value.timezone };
}

/** Find the first occurrence of a local day. Overlaps use the first instant; gaps have no occurrence. */
function dailyInstant(day, schedule) {
  const [hour, minute] = schedule.time.split(':').map(Number);
  const desired = { ...day, hour, minute, second: 0 }, naive = utc(desired), offsets = new Set();
  // Sample surrounding offsets rather than assuming an integer-hour offset or a 24-hour local day.
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = naive + hours * 3600000;
    offsets.add(utc(localParts(sample, schedule.timezone)) - sample);
  }
  const matches = [...offsets].map(offset => naive - offset).filter(timestamp => {
    const actual = localParts(timestamp, schedule.timezone);
    return Object.keys(desired).every(key => actual[key] === desired[key]);
  });
  return matches.length ? Math.min(...matches) : null;
}

/** Strictly after `after`; once returns null when expired. No polling, filesystem or side effects. */
export function nextHookRun(schedule, after) {
  check(Number.isFinite(after), 'invalid schedule clock');
  if (schedule.kind === 'once') return Date.parse(schedule.at) > after ? schedule.at : null;
  const local = localParts(after, schedule.timezone), start = utc({ year: local.year, month: local.month, day: local.day });
  for (let day = 0; day < 8; day += 1) {
    const date = new Date(start + day * 86400000);
    const timestamp = dailyInstant({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }, schedule);
    if (timestamp !== null && timestamp > after) return new Date(timestamp).toISOString();
  }
  throw new Error('schedule has no valid upcoming local date');
}
