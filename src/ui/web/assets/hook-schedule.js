// Browser-only wall-clock conversion. Never interpret a selected server timezone
// using Date's implicit local timezone. Ambiguous/nonexistent one-shot times fail closed.
function formatter(timezone) {
  if (typeof timezone !== 'string' || !timezone.trim() || /^[+-]/.test(timezone)) throw new Error('请填写有效的 IANA 时区，例如 Asia/Shanghai。');
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, calendar: 'gregory', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  } catch { throw new Error('请填写有效的 IANA 时区，例如 Asia/Shanghai。'); }
}
function parts(format, instant) {
  return Object.fromEntries(format.formatToParts(new Date(instant)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}
const wall = p => `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
export function browserTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
export function scheduledWallTime(instant, timezone) {
  const time = Date.parse(instant); if (!Number.isFinite(time)) throw new Error('指定日期无效。');
  return wall(parts(formatter(timezone), time));
}
export function scheduledInstant(local, timezone) {
  const format = formatter(timezone);
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(local);
  if (!match || Number(match[1]) < 1000) throw new Error('请填写完整的执行日期和时间。');
  const normalized = `${local.slice(0, 16)}:${match[6] || '00'}`;
  const nominal = Date.parse(`${normalized}Z`);
  if (!Number.isFinite(nominal) || new Date(nominal).toISOString().slice(0, 19) !== normalized) throw new Error('指定日期无效。');
  // Collect actual offsets on either side of a transition, then round-trip each
  // candidate. This includes half-/quarter-hour offsets and date-line changes.
  const offsets = new Set();
  for (let delta = -36; delta <= 36; delta += 0.5) {
    const sample = nominal + delta * 3600000;
    offsets.add(Date.parse(`${wall(parts(format, sample))}Z`) - sample);
  }
  const candidates = [...offsets].map(offset => nominal - offset).filter(time => wall(parts(format, time)) === normalized);
  if (!candidates.length) throw new Error('所选时区不存在这个时间（可能处于夏令时跳时）；请选择其他时间。');
  if (candidates.length !== 1) throw new Error('所选时区的这个时间出现两次（夏令时回拨）；请选择无歧义的时间。');
  return new Date(candidates[0]).toISOString();
}
export function hookSchedule(kind, local, time, timezone) {
  const zone = timezone.trim(); formatter(zone);
  if (kind === 'daily') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('请填写每日执行时间（HH:mm）。');
    return { kind, time, timezone: zone };
  }
  if (kind !== 'once') throw new Error('请选择一次性或每日定时。');
  return { kind, at: scheduledInstant(local, zone), timezone: zone };
}
export function hookScheduleSummary(schedule) {
  if (!schedule) return '';
  try {
    return schedule.kind === 'daily' ? `每天 ${schedule.time} · ${schedule.timezone}`
      : `${scheduledWallTime(schedule.at, schedule.timezone).replace('T', ' ')} · ${schedule.timezone}`;
  } catch { return '定时配置无效，请检查后台记录。'; }
}
