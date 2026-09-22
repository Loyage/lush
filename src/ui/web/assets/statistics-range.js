/** Calendar-only controls use the same UTC calendar as the usage API's buckets. */
const DAY = 86400000;
const isoDay = date => date.toISOString().slice(0, 10);
export const statisticsToday = (now = new Date()) => isoDay(now);
function midnight(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('请选择有效日期');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || isoDay(date) !== value) throw new Error('请选择有效日期');
  return date.getTime();
}
export function statisticsDefaults() {
  return { mode: 'daily', daily: { preset: 'all', start: '', end: '' },
    intraday: { preset: 'today', date: '', startHour: 0, endHour: 24 } };
}
export function statisticsDates(filters, now = new Date()) {
  const today = statisticsToday(now), at = midnight(today);
  if (filters.mode === 'intraday') {
    const { preset, date } = filters.intraday;
    return { date: preset === 'today' ? today : preset === 'yesterday' ? isoDay(new Date(at - DAY)) : date };
  }
  const { preset, start, end } = filters.daily;
  if (preset === 'all') return { start: '', end: '' };
  if (preset === '7d' || preset === '30d') return { start: isoDay(new Date(at - (preset === '7d' ? 6 : 29) * DAY)), end: today };
  if (preset === 'month') return { start: `${today.slice(0, 7)}-01`, end: today };
  return { start, end };
}
export function statisticsQuery(filters, now = new Date()) {
  const dates = statisticsDates(filters, now);
  const query = new URLSearchParams({ interval: filters.mode === 'daily' ? 'day' : 'hour' });
  if (filters.mode === 'daily') {
    const start = dates.start ? midnight(dates.start) : null;
    const end = dates.end ? midnight(dates.end) + DAY : null;
    if (start !== null && end !== null && start >= end) throw new Error('开始日期不能晚于结束日期');
    if (start !== null) query.set('start', new Date(start).toISOString());
    if (end !== null) query.set('end', new Date(end).toISOString());
  } else {
    const { startHour, endHour } = filters.intraday;
    if (!Number.isInteger(startHour) || !Number.isInteger(endHour) || startHour < 0 || endHour > 24 || startHour >= endHour) {
      throw new Error('开始小时必须早于结束小时（0–24 点）');
    }
    const day = midnight(dates.date);
    query.set('start', new Date(day + startHour * 3600000).toISOString());
    query.set('end', new Date(day + endHour * 3600000).toISOString());
  }
  return query;
}
