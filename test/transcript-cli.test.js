import { test, expect } from 'bun:test';
import { run } from '../src/cli/commands/task.js';
import { run as branch } from '../src/cli/commands/branch.js';
import { run as system } from '../src/cli/commands/system.js';
import { COMMANDS } from '../src/cli/specs/worker-system.js';
import { parseCLI, validateCLIParameters } from '../src/cli/parser.js';

test('Worker CLI preserves single reads and explicit views, requests and service boundaries', async () => {
  const page = { task_id: 7, steps: [{ seq: 10, kind: 'text', body: 'recorded text' }], next: 10, has_more: true };
  for (const token of [null, 'agent']) {
    const requests = [];
    const client = { token, async request(method, params) { requests.push({ method, params }); return page; } };
    expect(await run('worker', ['transcript', '7', '--after', '9'], { client, json: true })).toBe(page);
    expect(requests).toEqual([{ method: 'worker.transcript', params: { id: 7, after: 9 } }]);
  }
  const requests = [];
  const client = { token: null, async request(method, params) {
    requests.push({ method, params });
    if (method === 'worker.activity') return { tasks: [{ id: 20 }, { id: 10 }], page: { limit: 1, cursor: 10, has_more: true, total: 3, active: 1 } };
    if (method === 'worker.page') return { tasks: [{ id: 9 }], cursor: 9, has_more: false, limit: 1 };
    if (method === 'worker.list') return { tasks: [{ id: 1, goal: 'a' }], page: { limit: 1, requested_limit: 1, cursor: 1, next_cursor: 1,
      has_more: true, total: 2, shown: 1, byte_truncated: true }, coverage: 'worker_list_page' };
    return { accepted: true };
  } };
  const invoke = args => run('worker', args, { client, json: true });
  const recent = await invoke(['list', '--limit', '1']);
  expect(recent.page).toMatchObject({ total: 3, active: 1, limit: 1, has_more: true });
  await invoke(['list', '--limit', '1', '--cursor', recent.page.next_cursor]);
  expect(requests.map(entry => entry.method)).toEqual(['worker.activity','worker.page']);
  expect(requests[1].params).toEqual({ before: 10, limit: 1, scope: 'work' });
  await expect(invoke(['list', '--view', 'history', '--cursor', recent.page.next_cursor])).rejects.toThrow('cursor');
  await expect(invoke(['list', '--scope', 'all', '--cursor', recent.page.next_cursor])).rejects.toThrow('cursor');
  await expect(invoke(['list', '--brief'])).rejects.toThrow('--brief');
  const all = await invoke(['list', '--view', 'all', '--brief', '--limit', '1']);
  expect(all.tasks.map(item => item.id)).toEqual([1]); expect(all.page).toMatchObject({ has_more: true, total: 2, shown: 1, byte_truncated: true, source_next_cursor: 1 });
  expect(all.coverage).toBe('worker_list_page');
  expect(requests.at(-1)).toEqual({ method: 'worker.list', params: { after: 0, limit: 1, paged: true } });
  const before = requests.length;
  await expect(invoke(['merge', 'request', '5', '--after-merged', '6'])).rejects.toThrow('revision');
  await expect(invoke(['merge', '5'])).rejects.toThrow('request|show');
  await expect(invoke(['configure', '5', '--data', '{}'])).rejects.toThrow('unknown');
  expect(requests.length).toBe(before);
  await invoke(['merge', 'request', '5']);
  expect(requests.at(-1)).toEqual({ method: 'worker.reserve', params: { id: 5, kind: 'merge' } });
  await invoke(['merge', 'request', '5', '--after-merged', '6', '--revision', 'REV']);
  expect(requests.at(-1)).toEqual({ method: 'worker.merge_after', params: { id: 5, conditions: [{ kind: 'worker_merged', worker_id: 6 }], expected_revision: 'REV' } });
  await invoke(['automation', 'enable', '5', 'auto-merge', '--revision', 'HOOK_REV']);
  expect(requests.at(-1)).toEqual({ method: 'worker.hook_update', params: { id: 5, hook_id: 'auto-merge', enabled: true, expected_revision: 'HOOK_REV' } });
  await invoke(['config', 'set', '5', '--connection', 'UUID', '--model', 'provider/model']);
  expect(requests.at(-1)).toEqual({ method: 'worker.configure', params: { id: 5, model_selection: { connection_id: 'UUID', model: 'provider/model' } } });
  await invoke(['accept', '5']); expect(requests.at(-1)).toEqual({ method: 'worker.accept', params: { id: 5 } });
  await branch('branch', ['merge-all', 'main'], { client, json: true }); expect(requests.at(-1).method).toBe('worker.reserve_all');
  const beforeRemoved = requests.length;
  for (const args of [['create','--from','5'], ['watch','5'], ['wait','5'], ['graph'], ['merge','graph'], ['automation','list'], ['config','show','5'], ['accept-preview','5'], ['accept','5','--force','--confirm','--revision','REV'], ['cleanup','5']])
    await expect(invoke(args)).rejects.toThrow();
  for (const args of [['history'], ['versions'], ['graph'], ['integrate','preview','main'], ['legacy-convergence','list'], ['bind','feature','HEAD'], ['archive','feature']])
    await expect(branch('branch', args, { client, json: true })).rejects.toThrow('unknown branch');
  expect(requests).toHaveLength(beforeRemoved);
  await system('status', [], { client }); expect(requests.at(-1).method).toBe('system.summary');
  await system('status', ['--detail'], { client }); expect(requests.at(-1).method).toBe('system.status');
  await expect(system('status', ['--detail', '--development', 'true'], { client })).rejects.toThrow('cannot');
  await system('daemon', ['request-stop'], { client: { ...client, token: 'management', management: true } }); expect(requests.at(-1).method).toBe('system.stop');
  await expect(system('daemon', ['stop'], { client: { ...client, token: 'management', management: true } })).rejects.toThrow('local daemon');
  const parse = argv => { const value = parseCLI(argv, COMMANDS); return validateCLIParameters(value.args, value.entry); };
  expect(() => parse(['worker','automation','attach','5','--data','{"template_id":"definition","template_version":1}','--revision','REV'])).not.toThrow();
  expect(() => parse(['worker','automation','attach','5','--data','{}','--revision','REV'])).toThrow('payload schema');
  expect(() => parse(['worker','automation','attach','5','--file','must-not-open','--revision','REV'])).toThrow('unknown option');
  expect(() => parse(['worker','accept','5','--force'])).toThrow('unknown option');
  expect(new Set(COMMANDS.map(entry => entry.path)).size).toBe(COMMANDS.length);
  for (const command of COMMANDS) { expect(command.parameters).toBeDefined(); expect(command.recovery).toContain('未知'); }
});
