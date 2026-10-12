import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { PARAMS, USER_ONLY } from '../src/rpc/registry.js';
import { run as hooks } from '../src/cli/commands/hooks.js';

const id = 'ee2f98f1-fc9a-46b1-a37c-67d8595c0649';
const expected_revision = 'commands:revision';
const prompt = { name: '审查提交', kind: 'prompt', prompt: '检查当前项目的改动并给出建议。', description: '代码审查',
  when_to_use: '交付前', tags: ['review', '检查'], examples: '', warnings: '可能产生费用', default_worker_id: null };
function fixture() {
  const calls = [];
  const project = { actor: token => token ? 8 : null,
    saveShortcutCommand(...args) { calls.push(['save', ...args]); return { ok: true }; },
    exportShortcutCommand(...args) { calls.push(['export', ...args]); return { filename: 'SKILL.md', markdown: '---\nname: review\n---\n' }; } };
  return { calls, dispatcher: new Dispatcher(project) };
}

test('typed automation definitions pass through user-only RPC without broadening Agent permissions', async () => {
  const f = fixture();
  const { kind, ...promptEdit } = prompt;
  for (const command of [prompt, { ...promptEdit, id }, { name: 'test', kind: 'shell', command: 'bun run test', description: '', tags: [] }]) {
    expect(await f.dispatcher.dispatch('hooks.command_save', { command, expected_revision })).toEqual({ ok: true });
    expect(f.calls.at(-1)).toEqual(['save', command, expected_revision]);
    await expect(f.dispatcher.dispatch('hooks.command_save', { command, expected_revision, _token: 'agent' })).rejects.toThrow('requires user approval');
  }
  expect(f.calls).toHaveLength(3);
});

test('automation definition validation rejects wrong types, privilege additions and mixed bodies', async () => {
  const f = fixture();
  for (const command of [
    { ...prompt, command: 'echo wrong' }, { ...prompt, kind: 'other' }, { ...prompt, kind: 'shell' }, { ...prompt, name: 'bad\0name' },
    { ...prompt, authorized: true }, { ...prompt, profile: {} }, { ...prompt, cwd: '/tmp' },
    { ...prompt, prompt: '' }, { ...prompt, prompt: 'bad\0body' }, { ...prompt, prompt: 'x'.repeat(16001) },
    ...['description', 'when_to_use', 'examples', 'warnings'].flatMap(key => [null, [], 4, {}, 'bad\0value'].map(value => ({ ...prompt, [key]: value }))),
    ...['review', {}, null, [7], ['bad\0tag'], Array(33).fill('tag')].map(tags => ({ ...prompt, tags })),
  ]) await expect(f.dispatcher.dispatch('hooks.command_save', { command, expected_revision })).rejects.toThrow();
  expect(f.calls).toEqual([]);
});

test('metadata limits agree with runtime and reject oversized fields before mutation', async () => {
  const f = fixture();
  for (const [key, limit] of Object.entries({ description: 2000, when_to_use: 4000, examples: 8000, warnings: 4000 })) {
    const command = { ...prompt, [key]: 'x'.repeat(limit) };
    expect(await f.dispatcher.dispatch('hooks.command_save', { command, expected_revision })).toEqual({ ok: true });
    await expect(f.dispatcher.dispatch('hooks.command_save', { command: { ...command, [key]: 'x'.repeat(limit + 1) }, expected_revision })).rejects.toThrow(key);
  }
  expect(await f.dispatcher.dispatch('hooks.command_save', { command: { ...prompt, tags: ['x'.repeat(80)] }, expected_revision })).toEqual({ ok: true });
  await expect(f.dispatcher.dispatch('hooks.command_save', { command: { ...prompt, tags: ['x'.repeat(81)] }, expected_revision })).rejects.toThrow('tags');
  expect(f.calls).toHaveLength(5);
});

test('single definition export is version-bound, read-only and user-exclusive', async () => {
  const f = fixture();
  expect(PARAMS['hooks.command_export']).toEqual(['id', 'version']);
  expect(USER_ONLY.has('hooks.command_export')).toBe(true);
  const result = await f.dispatcher.dispatch('hooks.command_export', { id, version: 2 });
  expect(result.filename).toBe('SKILL.md');
  expect(f.calls).toEqual([['export', id, 2]]);
  for (const params of [{ id: 'bad', version: 2 }, { id, version: 0 }, { id, version: '2' },
    { id, version: 2, authorized: true }, { id, version: 2, _token: 'agent' }])
    await expect(f.dispatcher.dispatch('hooks.command_export', params)).rejects.toThrow();
  expect(f.calls).toHaveLength(1);
});

test('CLI saves metadata from private JSON and exports only an explicit version without mutations', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-automation-api-'));
  const file = path.join(dir, 'command.json');
  fs.writeFileSync(file, JSON.stringify(prompt), { mode: 0o600 });
  const calls = [], client = { request(method, params) { calls.push({ method, params }); return { ok: true }; } };
  try {
    await hooks('hooks', ['command', 'save', '--file', file, '--revision', expected_revision], { client });
    await hooks('hooks', ['command', 'export', id, '--version', '2'], { client });
    expect(calls).toEqual([
      { method: 'hooks.command_save', params: { command: prompt, expected_revision } },
      { method: 'hooks.command_export', params: { id, version: 2 } },
    ]);
    for (const args of [['export', id], ['export', id, '--version', '0'], ['export', id, '--version', '2', '--revision', expected_revision],
      ['export', 'bad', '--version', '2']])
      await expect(hooks('hooks', ['command', ...args], { client })).rejects.toThrow();
    await expect(hooks('hooks', ['command', 'export', id, '--version', '2'], { client: { ...client, token: 'agent' } })).rejects.toThrow('user only');
    expect(calls).toHaveLength(2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
