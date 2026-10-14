import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from '../helpers.js';
import { managementToolCLI } from '../agent/management-tool-cli-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { RPCServer } from '../../src/rpc/server.js';
import { createSignal } from '../../src/signal.js';
import { managementCodeReadResult } from '../../src/core/project/management-code.js';
import { managementSafeResult } from '../../src/core/project/management-control.js';

async function setup() {
  const f = fixture(); f.project.kick = () => {};
  f.target = f.store.create({ role: 'agent', task_kind: 'order', goal: '😀'.repeat(300) + 'SECRET_GOAL_SUFFIX', name: 'metadata-target' });
  f.store.update(f.target.id, { status: 'paused' });
  f.cli = managementToolCLI(f.root, 'node');
  f.config.env.LUSH_PI_COMMAND = f.cli.command;
  f.project.provider = new AgentProvider(f.config, f.project.agentSettings);
  f.rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {})); await f.rpc.start();
  f.read = async (method, params) => {
    f.cli.plan([{ name: 'manager_call', params: { method, params } }]);
    const manager = f.project.submitManagementInstruction({ instruction: 'read bounded metadata', profile: { agent: 'pi', config_mode: 'pi' } }).task;
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    const reply = JSON.parse(f.store.task(manager.id).result).replies[0];
    expect(reply.error).toBeUndefined();
    expect(reply.response.details.status).toBe('succeeded');
    const result = reply.response.details.result;
    expect(JSON.stringify(result)).not.toContain('SECRET_');
    return result;
  };
  return f;
}
function session(f, count, padding = '') {
  const filename = path.join(f.config.home, 'sessions', `fixture_lush-task-${f.target.id}.jsonl`);
  const records = Array.from({ length: count }, (_, index) => ({ type: 'message', timestamp: '2026-01-01T00:00:00Z', message: {
    role: 'assistant', content: [index % 2 ? { type: 'text', text: 'SECRET_PROMPT_AND_OUTPUT' }
      : { type: 'toolCall', id: `SECRET_CALL_${index}`, name: 'SECRET_TOOL', arguments: { env: 'SECRET_ENV', credential: 'SECRET_KEY' } }],
  } }));
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, records.map(row => JSON.stringify(row)).join('\n') + '\n' + padding);
  return filename;
}

for (const count of [150, 250]) test(`real Provider -> manager_call -> bridge retains every seq exactly once with limit 200 and ${count} source steps`, async () => {
  const f = await setup();
  try {
    session(f, count);
    const seen = []; let after = 0;
    // Finite pagination of immutable fixture data, not a runtime waiting/poll loop.
    for (let page = 0; page < Math.ceil(count / 100); page++) {
      const result = await f.read('worker.transcript', { id: f.target.id, after, limit: 200 });
      expect(result.coverage).toBe('step_metadata_only');
      expect(result.steps.length).toBe(Math.min(100, count - after));
      expect(result.next).toBe(result.steps.at(-1).seq);
      expect(result.has_more).toBe(result.next < count);
      expect(result.truncated).toBe(false); // Upstream byte truncation remains a separate fact.
      expect(result.steps_truncated).toBe(count - after > 100);
      seen.push(...result.steps.map(step => step.seq)); after = result.next;
    }
    expect(seen).toEqual(Array.from({ length: count }, (_, index) => index + 1));
    expect(new Set(seen).size).toBe(count);
    const empty = await f.read('worker.transcript', { id: f.target.id, after, limit: 200 });
    expect(empty).toMatchObject({ steps: [], next: count, has_more: false, truncated: false, steps_truncated: false });
    const single = await f.read('worker.transcript', { id: f.target.id, limit: 1 });
    expect(single).toMatchObject({ steps: [{ seq: 1 }], next: 1, has_more: true, truncated: false, steps_truncated: false });
  } finally { await f.rpc.close(); await f.close(); }
});

test('real bridge preserves upstream byte truncation even on an empty page, without inventing a progressing cursor', async () => {
  const f = await setup();
  try {
    // One incomplete/over-budget JSONL row: the compatibility reader cannot reach a step.
    session(f, 0, JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'SECRET_' + 'x'.repeat(8 * 1024 * 1024) }] } }) + '\n');
    expect(await f.read('worker.transcript', { id: f.target.id, after: 7, limit: 200 }))
      .toMatchObject({ steps: [], next: 7, has_more: false, truncated: true, steps_truncated: false });
  } finally { await f.rpc.close(); await f.close(); }
});

test('typed clipping and generic safety exit preserve upstream flags and the last actually returned step', () => {
  for (const truncated of [false, true]) for (const has_more of [false, true]) {
    const source = { task_id: 9, next: 160, has_more, truncated, steps: Array.from({ length: 150 }, (_, i) => ({ seq: 11 + i, kind: 'text', body: 'SECRET_RAW' })) };
    const limits = {}, result = managementSafeResult(managementCodeReadResult('worker.transcript', source, null, { after: 10 }), limits);
    expect(result).toMatchObject({ next: 110, has_more: true, truncated, steps_truncated: true });
    expect(result.steps).toHaveLength(100);
    expect(limits.truncated).toBeUndefined(); // No second silent array crop can invalidate the typed cursor.
    expect(JSON.stringify(result)).not.toContain('SECRET_');
    expect(source.steps).toHaveLength(150); expect(source.next).toBe(160);
  }
  for (const steps of [[], [{ seq: 11, kind: 'text' }]]) {
    const result = managementSafeResult(managementCodeReadResult('worker.transcript', { task_id: 9, steps, next: steps.at(-1)?.seq ?? 10, has_more: true, truncated: true }, null, { after: 10 }));
    expect(result).toMatchObject({ next: steps.at(-1)?.seq ?? 10, has_more: true, truncated: true, steps_truncated: false });
  }
});

test('real bridge history continuation returns every persisted event exactly once without its private body', async () => {
  const f = await setup();
  try {
    for (let i = 0; i < 165; i++) f.store.event(f.target.id, 'fixture.metadata', { env: 'SECRET_ENV', prompt: 'SECRET_PROMPT', output: 'SECRET_OUTPUT' });
    const expected = f.store.all('SELECT id FROM events WHERE task_id=? ORDER BY id', f.target.id).map(row => row.id);
    const seen = []; let after = 0;
    for (let page = 0; page < Math.ceil(expected.length / 100); page++) {
      const result = await f.read('worker.history', { id: f.target.id, after });
      expect(result.events.length).toBeLessThanOrEqual(100);
      expect(result.next).toBe(result.events.at(-1).id);
      expect(result.has_more).toBe(result.next < expected.at(-1));
      expect(result.events_truncated).toBe(false);
      seen.push(...result.events.map(event => event.id)); after = result.next;
    }
    expect(seen).toEqual(expected);
    expect(await f.read('worker.history', { id: f.target.id, after }))
      .toMatchObject({ events: [], next: after, has_more: false, events_truncated: false });
  } finally { await f.rpc.close(); await f.close(); }
});

test('typed history projection owns its cursor even if an upstream window exceeds the generic exit budget', () => {
  const events = Array.from({ length: 150 }, (_, i) => ({ id: i + 101, task_id: 9, type: 'fixture.metadata', created_at: '2026-01-01', data: 'SECRET_BODY' }));
  let cursor;
  const project = { store: { get(_sql, _task, after) { cursor = after; return after < 250 ? { id: after + 1 } : null; } } };
  const limits = {}, result = managementSafeResult(managementCodeReadResult('worker.history', events, project, { id: 9, after: 100 }), limits);
  expect(result).toMatchObject({ next: 200, has_more: true, events_truncated: true });
  expect(result.events).toHaveLength(100); expect(cursor).toBe(200);
  expect(limits.truncated).toBeUndefined(); expect(JSON.stringify(result)).not.toContain('SECRET_');
  expect(events).toHaveLength(150);
});

test('real manager_call marks goal clipping for inspect and already clipped tree summaries', async () => {
  const f = await setup();
  try {
    const inspect = await f.read('worker.inspect', { id: f.target.id });
    expect(inspect.goal).toHaveLength(500);
    expect(inspect).toMatchObject({ goal_length: f.target.goal.length, goal_truncated: true, coverage: 'worker_metadata_only' });
    const tree = await f.read('worker.tree', { id: f.target.id });
    expect(tree.goal).toHaveLength(400); // SQLite summaries retain 200 Unicode code points, not UTF-16 units.
    expect(tree).toMatchObject({ goal_length: f.target.goal.length, goal_truncated: true });
    const short = f.store.create({ role: 'agent', task_kind: 'order', goal: 'short', name: 'short-metadata' });
    f.store.update(short.id, { status: 'paused' });
    expect(await f.read('worker.inspect', { id: short.id })).toMatchObject({ goal: 'short', goal_length: 5, goal_truncated: false });
  } finally { await f.rpc.close(); await f.close(); }
});
