import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from 'bun:test';
import { CLI_COMMANDS } from '../src/cli/catalog.js';
import { assertAllowed } from '../src/rpc/registry.js';
import { run as order } from '../src/cli/commands/intent.js';
import { run as worker } from '../src/cli/commands/task.js';
import { run as agent } from '../src/cli/commands/agent.js';
import { run as config } from '../src/cli/commands/config.js';
import { run as notice } from '../src/cli/commands/notice.js';
import { fixture } from './helpers.js';
const handlers = { order, worker, agent, config, notice };
const uuid = '11111111-1111-4111-8111-111111111111';

test('option-dependent multi-RPC mappings are actual CLI branches, not RPC aliases or broad CLI execution grants', async () => {
  const f = fixture(); f.project.kick = () => {};
  const urlFile = path.join(f.root, 'callback.txt'); fs.writeFileSync(urlFile, 'http://localhost/callback?code=synthetic', { mode: 0o600 });
  const answersFile = path.join(f.root, 'answers.json'); fs.writeFileSync(answersFile, JSON.stringify({ answers: [] }));
  const seen = new Map();
  const variants = [
    ['order', ['目标', '--buffer'], ['draft.add']],
    ['order', ['管理需求', '--management'], ['management.submit']],
    ['order', ['追加', '--append', 'W5', '--after-merged', 'W5'], ['worker.lookup','worker.lookup','input.emit']],
    ['worker delete', ['delete','W5','--confirm','--revision','REV'], ['worker.lookup','worker.delete']],
    ['agent sources models', ['sources','models',uuid,'--refresh'], ['agent.connections.models.refresh']],
    ['agent sources login', ['sources','login',uuid,'--callback'], ['agent.connections.login.start']],
    ['agent sources login', ['sources','login',uuid,'--poll',uuid], ['agent.connections.device.poll']],
    ['agent sources login', ['sources','login',uuid,'--cancel',uuid], ['agent.connections.device.cancel']],
    ['agent sources login', ['sources','login',uuid,'--finish',uuid,'--url-file',urlFile], ['agent.connections.login.finish']],
    ['config show', ['show','--scope','device'], ['system.settings']],
    ['config migrate', ['migrate','--confirm','--revision','REV'], ['settings.migration.apply']],
    ['notice answer', ['answer','12','--answers-file',answersFile], ['notice.answer']],
  ];
  try {
    for (const [catalogPath, args, expected] of variants) {
      const item = CLI_COMMANDS.find(item => item.path === catalogPath), calls = [];
      const command = catalogPath.split(' ')[0];
      const client = { config: f.config, token: null, async request(method, params = {}) {
        calls.push(method); assertAllowed(method, params, null); expect(item.rpc).toContain(method);
        if (!seen.has(catalogPath)) seen.set(catalogPath, new Set()); seen.get(catalogPath).add(method);
        if (method === 'worker.lookup') return { id: 5, worker_number: params.number };
        if (method === 'system.settings') return { call_timeout: {}, task_call_limit: {}, max_depth: {}, input_routes: { value: [], default: [] } };
        if (method === 'agent.connections.models.refresh') return { version: 1, id: uuid, status: 'fresh', source: 'listing', models: [] };
        return { id: uuid };
      } };
      await handlers[command](command, [...args], { client, json: true }); expect(calls).toEqual(expected);
    }
    expect([...seen.get('agent sources login')].sort()).toEqual(['agent.connections.login.start','agent.connections.login.finish','agent.connections.device.poll','agent.connections.device.cancel'].sort());
    const orderEntry = CLI_COMMANDS.find(item => item.path === 'order');
    expect(orderEntry.format).toBe("lush order '目标'"); expect(orderEntry.usage).toContain('--management');
    expect(orderEntry.usage).toContain('--after-merged');
  } finally { await f.close(); }
});
