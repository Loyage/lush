import { test, expect } from 'bun:test';
import { normalizeHookSchedule, nextHookRun } from '../src/core/hook-schedule.js';
import { normalizeHook, publicHookDefinition, HOOK_ACTIONS } from '../src/core/hooks.js';
const ms = value => Date.parse(value);
const daily = (time, timezone = 'Asia/Shanghai') => normalizeHookSchedule({ kind: 'daily', time, timezone }, 'persistent');
const rule = schedule => ({ name: 'clock', trigger: 'time.scheduled', enabled: true, mode: schedule.kind === 'once' ? 'once' : 'persistent', schedule,
  actions: [{ type: 'notify', title: 'clock', body: '' }] });

test('schedule validates exact dates, explicit offsets, zones, kinds, modes and bounded fields', () => {
  const once = normalizeHookSchedule({ kind: 'once', at: '2030-01-02T00:05:00+08:00', timezone: 'Asia/Shanghai' }, 'once');
  expect(once.at).toBe('2030-01-01T16:05:00.000Z');
  expect(nextHookRun(once, ms('2030-01-01T16:04:00Z'))).toBe(once.at);
  expect(nextHookRun(once, ms(once.at))).toBeNull();
  for (const at of ['2030-01-02T00:05:00', '2030-02-30T00:05Z', '2030-01-02T24:00Z', '2030-01-02T00:00:60Z', '2030-01-02T00:00:00+24:00', 'garbage'])
    expect(() => normalizeHookSchedule({ kind: 'once', at, timezone: 'UTC' }, 'once')).toThrow('valid ISO');
  expect(() => daily('0:05')).toThrow('HH:mm');
  expect(() => daily('24:00')).toThrow('HH:mm');
  expect(() => daily('00:00', 'Invented/Zone')).toThrow('timezone');
  expect(() => daily('00:00', '+08:00')).toThrow('timezone');
  expect(() => normalizeHookSchedule({ kind: 'daily', time: '00:05', timezone: 'UTC', cron: '*' }, 'persistent')).toThrow('fields');
  expect(() => normalizeHookSchedule({ kind: 'daily', time: '00:05', timezone: 'UTC' }, 'once')).toThrow('persistent');
  expect(() => normalizeHookSchedule({ kind: 'once', at: once.at, timezone: 'UTC' }, 'persistent')).toThrow('once');
  expect(() => normalizeHook({ ...rule(once), trigger: 'agent.returned' })).toThrow('only allowed');
  expect(() => normalizeHook({ ...rule(once), schedule: undefined })).toThrow('requires a schedule');
});

test('daily schedules cross local dates, months and non-integer UTC offsets independently of daemon timezone', () => {
  expect(nextHookRun(daily('00:05'), ms('2030-01-01T16:04:00Z'))).toBe('2030-01-01T16:05:00.000Z');
  expect(nextHookRun(daily('00:05'), ms('2030-01-01T16:05:00Z'))).toBe('2030-01-02T16:05:00.000Z');
  expect(nextHookRun(daily('00:05'), ms('2030-01-31T16:06:00Z'))).toBe('2030-02-01T16:05:00.000Z');
  expect(nextHookRun(daily('00:05', 'Asia/Kathmandu'), ms('2030-01-01T18:19:00Z'))).toBe('2030-01-01T18:20:00.000Z');
  expect(nextHookRun(daily('00:05', 'Pacific/Kiritimati'), ms('2030-01-01T10:04:00Z'))).toBe('2030-01-01T10:05:00.000Z');
});

test('DST overlap fires only first instant and gap skips the date, including half-hour transitions', () => {
  const ny = daily('01:30', 'America/New_York');
  expect(nextHookRun(ny, ms('2026-11-01T04:00:00Z'))).toBe('2026-11-01T05:30:00.000Z');
  expect(nextHookRun(ny, ms('2026-11-01T05:31:00Z'))).toBe('2026-11-02T06:30:00.000Z');
  expect(nextHookRun(daily('02:30', 'America/New_York'), ms('2026-03-08T05:00:00Z'))).toBe('2026-03-09T06:30:00.000Z');
  expect(nextHookRun(daily('02:15', 'Australia/Lord_Howe'), ms('2026-10-03T14:00:00Z'))).toBe('2026-10-04T15:15:00.000Z');
  expect(nextHookRun(daily('00:05', 'Pacific/Apia'), ms('2011-12-29T10:06:00Z'))).toBe('2011-12-30T10:05:00.000Z');
});

test('only time.scheduled lifts message/create once fuse, restarts are timed and profiles stay private', () => {
  const schedule = daily('00:05');
  for (const action of [{ type: 'create_worker', content: 'job' }, { type: 'message', target_id: 2, body: 'again' },
    { type: 'retry_worker', target_id: 2 }, { type: 'resume_worker', target_id: 2 }]) {
    expect(normalizeHook({ ...rule(schedule), actions: [action] }).mode).toBe('persistent');
  }
  expect(() => normalizeHook({ name: 'no recursion', trigger: 'agent.returned', mode: 'persistent', enabled: true,
    actions: [{ type: 'message', target_id: 2, body: 'again' }] })).toThrow('must be once');
  expect(() => normalizeHook({ ...rule(schedule), actions: [{ type: 'request_merge' }] })).toThrow('not allowed');
  expect(() => normalizeHook({ ...rule(schedule), trigger: 'agent.failed', schedule: undefined, actions: [{ type: 'retry_worker', target_id: 2 }] })).toThrow('not allowed');
  const privateRule = normalizeHook({ ...rule(schedule), actions: [{ type: 'retry_worker', target_id: 2,
    profile: { agent: 'pi', model: 'codex/model', append_prompt: 'PRIVATE_PROMPT', env: { PRIVATE_SECRET: 'PRIVATE_VALUE' } } }] });
  const view = publicHookDefinition(privateRule);
  expect(view.schedule).toEqual(schedule);
  expect(view.actions[0].model_selection.model).toBe('codex/model');
  expect(JSON.stringify(view)).not.toContain('PRIVATE_');
  expect(HOOK_ACTIONS.find(a => a.type === 'message').modes_by_trigger['time.scheduled']).toEqual(['once','persistent']);
});
