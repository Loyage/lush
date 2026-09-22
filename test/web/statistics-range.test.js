import { test, expect } from 'bun:test';
import { statisticsDefaults, statisticsDates, statisticsQuery } from '../../src/ui/web/assets/statistics-range.js';

const now = new Date('2024-03-01T01:00:00Z');
test('daily defaults to all history; quick date ranges use UTC and cross leap days correctly', () => {
  const filters = statisticsDefaults();
  expect(statisticsQuery(filters, now).toString()).toBe('interval=day');
  for (const [preset, start] of [['7d', '2024-02-24'], ['30d', '2024-02-01'], ['month', '2024-03-01']]) {
    filters.daily.preset = preset;
    expect(statisticsDates(filters, now)).toEqual({ start, end: '2024-03-01' });
    expect(statisticsQuery(filters, now).get('end')).toBe('2024-03-02T00:00:00.000Z');
  }
  filters.daily = { preset: 'custom', start: '2024-02-29', end: '2024-02-29' };
  const query = statisticsQuery(filters, now);
  expect(query.get('start')).toBe('2024-02-29T00:00:00.000Z');
  expect(query.get('end')).toBe('2024-03-01T00:00:00.000Z');
  filters.daily.end = '2024-02-28'; expect(() => statisticsQuery(filters, now)).toThrow('开始日期');
  filters.daily.end = ''; expect(statisticsQuery(filters, now).has('end')).toBe(false);
  filters.daily.start = '2023-02-29'; expect(() => statisticsQuery(filters, now)).toThrow('有效日期');
});

test('intraday resolves today and yesterday at query time and supports 24:00 without local timezone drift', () => {
  const filters = statisticsDefaults(); filters.mode = 'intraday';
  expect(statisticsDates(filters, now)).toEqual({ date: '2024-03-01' });
  filters.intraday.preset = 'yesterday';
  expect(statisticsQuery(filters, now).get('start')).toBe('2024-02-29T00:00:00.000Z');
  expect(statisticsQuery(filters, now).get('end')).toBe('2024-03-01T00:00:00.000Z');
  filters.intraday = { preset: 'custom', date: '2024-12-31', startHour: 23, endHour: 24 };
  const query = statisticsQuery(filters, now);
  expect(query.get('interval')).toBe('hour');
  expect(query.get('start')).toBe('2024-12-31T23:00:00.000Z');
  expect(query.get('end')).toBe('2025-01-01T00:00:00.000Z');
  for (const [startHour, endHour] of [[9, 9], [12, 8], [-1, 24], [0, 25], [0.5, 24]]) {
    Object.assign(filters.intraday, { startHour, endHour });
    expect(() => statisticsQuery(filters, now)).toThrow('开始小时');
  }
});
