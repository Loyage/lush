import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_CAPABILITIES } from '../src/agent/capabilities.js';
import { main } from '../src/cli/main.js';
import { cliHelpDocument } from '../src/cli/catalog.js';
import { CLI_MIGRATIONS } from '../src/cli/migrations.js';
import { env, temp } from './helpers.js';

const root = path.resolve(import.meta.dir, '..');
async function invoke(command, args, cwd) {
  const proc = Bun.spawn([command, ...args], { cwd, env: env(), stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}

test('published bins and source scripts expose executable lushw', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  expect(manifest.bin.lushw).toBe('./bin/lushw');
  expect(manifest.scripts.lushw).toBe('bun ./bin/lushw');
  const bin = path.join(root, 'bin/lushw');
  expect(fs.statSync(bin).mode & 0o111).not.toBe(0);
  const cwd = temp();
  try {
    const local = await invoke(bin, ['skills', 'list', '--json'], cwd);
    expect(local.code, local.err).toBe(0);
    expect(JSON.parse(local.out).version).toBe(1);
    expect(JSON.parse(local.out).data.map(entry => entry.id)).toEqual(AGENT_CAPABILITIES.map(entry => entry.id));
    const source = await invoke(process.execPath, ['run', 'lushw', '--help'], root);
    expect(source.code, source.err).toBe(0);
    expect(source.out).toContain('lushw [--project PATH]');
    const management = await invoke(path.join(root, 'bin/lush'), ['--help'], cwd);
    expect(management.code, management.err).toBe(0);
    expect(management.out).toContain('lush [--project PATH]');
    expect(management.out).toContain('order');
    const machine = await invoke(bin, ['help', '--all', '--limit', '2', '--json'], cwd);
    const first = JSON.parse(machine.out);
    expect(first.data.kind).toBe('index');
    expect(first.data.items).toHaveLength(2);
    expect(first.page.has_more).toBe(true);
    const second = cliHelpDocument('lushw', ['--all', '--limit', '2', '--cursor', first.page.next_cursor]);
    expect(second.data.items[0].path).not.toBe(first.data.items[0].path);
    expect(() => cliHelpDocument('lush', ['--all', '--cursor', first.page.next_cursor])).toThrow('another catalogue/view/query');
    const requests = [], values = [];
    const binding = { id: 'registered-id', name: 'astra', connection_id: '11111111-1111-4111-8111-111111111111', model: 'deepseek/deepseek-chat' };
    const context = { executable: 'lush', management: { assertCommand() {}, client: {
      management: true, request(method, params) { requests.push({ method, params }); return method === 'agent.registered_models.resolve' ? binding : { status: 'waiting' }; },
    } }, output: value => values.push(value) };
    await main(['worker', 'message', '7', '--json', '--', '--help'], context);
    expect(requests).toEqual([{ method: 'worker.message', params: { id: 7, body: '--help' } }]);
    expect(values[0]).toMatchObject({ version: 1, data: { status: 'waiting' } });
    requests.length = 0;
    await expect(main(['worker', 'message', '7', 'body', '--wat'], context)).rejects.toThrow('unknown option');
    await expect(main(['worker', 'message', '7', 'body', '--json', '--json'], context)).rejects.toThrow('duplicate');
    await expect(main(['worker', '--', 'message', '7', 'literal'], context)).rejects.toThrow('unknown command');
    await expect(main(['--', 'worker', 'message', '7', 'literal'], context)).rejects.toThrow('unknown command');
    await expect(main(['help', '--', '--all'], context)).rejects.toThrow('unknown help topic');
    for (const retired of CLI_MIGRATIONS.filter(item => item.replacement.startsWith('此 CLI 已删除'))) {
      await expect(main(retired.path.split(' '), context)).rejects.toThrow('已移除');
    }
    for (const argv of [
      ['order','goal','--profile-file','must-not-open'], ['input','draft','submit','5','--revision','1','--profile-file','must-not-open'],
      ['notice','ask','title','--worker','7','--questions-file','must-not-open'], ['notice','answer','12','--answers-file','must-not-open'],
      ['config','runtime','set','--file','must-not-open'], ['config','agent','replace','--file','must-not-open'],
      ['automation','register','--file','must-not-open'], ['worker','accept','7','--force'],
    ]) await expect(main(argv, context)).rejects.toThrow('unknown option');
    expect(requests).toHaveLength(0);
    await main(['order','goal','--data','{"agent":"pi","config_mode":"pi"}'], context);
    expect(requests.at(-1)).toEqual({ method: 'order.submit', params: { content: 'goal', profile: { agent: 'pi', config_mode: 'pi' } } });
    requests.length = 0;
    await main(['order','registered goal','--registered-model','astra','--scope','device','--when-idle','--data','{"thinking":"high"}'], context);
    expect(requests).toEqual([
      { method: 'agent.registered_models.resolve', params: { selector: 'astra', scope: 'device' } },
      { method: 'input.emit', params: { content: 'registered goal', conditions: [{ kind: 'parent_quiet' }],
        profile: { agent: 'pi', config_mode: 'lush', thinking: 'high', connection_id: binding.connection_id, model: binding.model } } },
    ]);
    requests.length = 0;
    for (const args of [
      ['order','goal','--registered-model','astra','--data','{"agent":"pi","config_mode":"pi"}'],
      ['order','goal','--registered-model','astra','--data','{"agent":"pi","model":null}'],
      ['worker','config','set','5','--registered-model','astra','--data','{"agent":"pi"}'],
    ]) await expect(main(args, context)).rejects.toThrow();
    expect(requests).toEqual([]);
    await main(['input','draft','submit','5','--revision','1','--data','{"agent":"pi","config_mode":"pi"}'], context);
    expect(requests.at(-1)).toEqual({ method: 'input.emit', params: { draft_id: 5, expected_revision: 1, profile: { agent: 'pi', config_mode: 'pi' } } });
    await main(['notice','answer','12','--data','{"answers":[{"selected":[0]}]}'], context);
    expect(requests.at(-1)).toEqual({ method: 'notice.answer', params: { id: 12, answer: { answers: [{ selected: [0] }] } } });
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
