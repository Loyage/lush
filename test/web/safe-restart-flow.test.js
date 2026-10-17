import { test, expect } from 'bun:test';
import { safeRestartFlow } from '../../src/ui/web/assets/safe-restart-flow.js';

const batch = '00000000-0000-4000-8000-000000000001';
const otherBatch = '00000000-0000-4000-8000-000000000002';
const initial = () => ({ paused: false, phase: 'running', ready_to_restart: true,
  batch_id: null, completion_state: null, completion_notice_id: null, notify_completion: null });
const complete = () => ({ paused: true, phase: 'paused', ready_to_restart: true,
  batch_id: batch, completion_state: 'completed', completion_notice_id: null, notify_completion: false });
async function flow({ original = initial(), ack = complete(), observed = ack, failSecond = false, afterRestart = observed } = {}) {
  let state = { ...original }, interrupted = false, restarted = false; const writes = [];
  const row = id => ({ id, project: `/isolated/${id}`, name: id, running: true, summary: { maintenance: id === 'bbbbbbbbbbbbbbbb' ? initial() : state } });
  const result = await safeRestartFlow({ signal: new AbortController().signal, checkPage() {},
    confirm: async () => true, recover: async () => true, reload() {}, observationTimeout: 100,
    request: async (route, options = {}) => {
      if (route === '/api/host') return { restart_supported: true, pid: 10 };
      if (route === '/api/host/projects') {
        if (interrupted) state = { ...(restarted ? afterRestart : observed) };
        return { projects: [row('aaaaaaaaaaaaaaaa'), ...(failSecond ? [row('bbbbbbbbbbbbbbbb')] : [])] };
      }
      writes.push([route, JSON.parse(options.body)]);
      if (route.endsWith('/api/action')) {
        if (route.includes('/bbbbbbbbbbbbbbbb/')) throw new Error('controlled second-source failure');
        if (JSON.parse(options.body).method === 'system.interrupt_all') {
          interrupted = true; state = { ...ack }; return state;
        }
        interrupted = false; state = { ...state, paused: false, phase: 'running', completion_state: 'cancelled', completion_notice_id: null };
        return state;
      }
      if (route.endsWith('/api/service/restart')) {
        restarted = true; return { restarted: true, project: '/isolated/aaaaaaaaaaaaaaaa', pid: 11 };
      }
      if (route === '/api/host/restart') return { restarting: true };
      throw new Error(`unexpected ${route}`);
    },
  });
  return { result, writes };
}

for (const [label, change] of [
  ['old daemon no silent ACK', { notify_completion: undefined, completion_notice_id: 7 }],
  ['missing evidence', { notify_completion: undefined }],
  ['unknown completion', { completion_state: 'unknown' }],
  ['forged string policy', { notify_completion: 'false' }],
  ['silent batch with inconsistent notice', { completion_notice_id: 7 }],
]) test(`safe restart stops without any service mutation: ${label}`, async () => {
  const { result, writes } = await flow({ ack: { ...complete(), ...change } });
  expect(result.error).toBeDefined();
  expect(writes).toHaveLength(1); expect(writes[0][1].params).toEqual({ notify_completion: false });
});

for (const [label, observed] of [
  ['replaced batch', { ...complete(), batch_id: otherBatch }],
  ['changed policy', { ...complete(), notify_completion: true, completion_notice_id: 7 }],
  ['withdrawn batch', { ...initial(), batch_id: batch, completion_state: 'cancelled', notify_completion: false }],
  ['unknown recovered batch', { ...complete(), completion_state: 'unknown' }],
]) test(`safe restart pins batch and policy during fresh observation: ${label}`, async () => {
  const { result, writes } = await flow({ observed });
  expect(result.error).toBeDefined(); expect(writes).toHaveLength(1);
});

test('a completed silent batch is not readiness once a dynamic barrier returns after restart', async () => {
  const { result, writes } = await flow({ afterRestart: { ...complete(), ready_to_restart: false, phase: 'pausing' } });
  expect(result.error).toBeDefined(); expect(writes).toHaveLength(2);
  expect(writes.at(-1)[0]).toEndWith('/api/service/restart');
});

test('already paused legacy notified and explicit silent batches are preserved, never resumed', async () => {
  for (const original of [complete(), { ...complete(), notify_completion: undefined, completion_notice_id: 7 }]) {
    const { result, writes } = await flow({ original });
    expect(result.error).toBeUndefined();
    expect(writes.map(([route]) => route)).toEqual(['/p/aaaaaaaaaaaaaaaa/api/service/restart', '/api/host/restart']);
  }
});

test('partial interruption failure does not retry, restart, resume, or hide accepted first batch', async () => {
  const { result, writes } = await flow({ failSecond: true });
  expect(result.error).toBeDefined(); expect(writes).toHaveLength(2);
  expect(writes.every(([, body]) => body.method === 'system.interrupt_all')).toBe(true);
  expect(result.message).toContain('中断已接受：aaaaaaaaaaaaaaaa');
  expect(result.message).toContain('不自动重试');
});
