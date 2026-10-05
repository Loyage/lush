import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from '../helpers.js';
import { install } from './agent-connection-fixture.js';
import { saveNetworkConfiguration } from '../../src/agent/network.js';
import { PiProvider, CodexProvider } from '../../src/agent/provider.js';
import { discoverAgentModels } from '../../src/agent/models.js';

const network = url => ({ version: 1, mode: 'proxy', proxy_url: url, no_proxy: [] });

test('connection query single-flight separates changed project network while retaining connection identity', async () => {
  const f = fixture(), { manager, service } = install(f); let release, enter;
  const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { enter = resolve; });
  const original = manager.query.bind(manager), routes = [];
  manager.query = async (id, snapshot) => { routes.push(snapshot.route('https://official.example')); const value = await original(id); if (routes.length === 1) { enter(); await gate; } return value; };
  try {
    saveNetworkConfiguration(f.config, network('http://first.example:8080'));
    const first = service.query('conn-one'); await entered;
    const same = service.query('conn-one');
    saveNetworkConfiguration(f.config, network('http://second.example:8080'));
    const next = service.query('conn-one');
    release(); await Promise.all([first, same, next]);
    expect(routes).toEqual(['http://first.example:8080/', 'http://second.example:8080/']);
    expect(manager.calls).toBe(2); expect(service.flights.size).toBe(0);
    expect((await service.history('conn-one')).series.length).toBeGreaterThan(0);
  } finally { release?.(); await f.close(); }
});

test('Pi/Codex and model directory children receive network defaults; role and Worker aliases take precedence', async () => {
  const f = fixture(), command = path.join(f.root, 'fake-cli.js');
  const observed = path.join(f.root, 'child-env.jsonl');
  fs.writeFileSync(command, `#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2), env={HTTP_PROXY:process.env.HTTP_PROXY,http_proxy:process.env.http_proxy,HTTPS_PROXY:process.env.HTTPS_PROXY,https_proxy:process.env.https_proxy,ALL_PROXY:process.env.ALL_PROXY,NO_PROXY:process.env.NO_PROXY};
fs.appendFileSync(${JSON.stringify(observed)},JSON.stringify(env)+'\\n');
if(args.includes('--list-models')) console.log('provider  model\\ndeepseek  fixture');
else if(args.includes('models')) console.log(JSON.stringify({models:[{slug:'fixture',display_name:'Fixture'}]}));
else if(args.includes('--output-last-message')) { fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'done');console.log(JSON.stringify({type:'thread.started',thread_id:'test-thread'})); }
else console.log('done');
`, { mode: 0o755 });
  f.config.env.LUSH_PI_COMMAND = command; f.config.env.LUSH_CODEX_COMMAND = command;
  f.config.env.http_proxy = 'http://old-daemon.example'; f.config.env.ALL_PROXY = 'socks5://old-daemon.example';
  const agentDir = path.join(f.config.home, 'agent'); fs.mkdirSync(agentDir, { mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, 'agent.env'), 'https_proxy="http://common.example"\n', { mode: 0o600 });
  const task = { id: 900, role: 'agent', goal: 'fixture child', task_kind: 'order' }, context = { invocation: { run_id: 55 } };
  const agent = { agent: 'pi', model: '', thinking: '', extensions: [], skills: [], env: { HTTPS_PROXY: 'http://worker.example' } };
  const run = { task, context, messages: [], cwd: f.root, token: 'test-token', signal: new AbortController().signal, onSpawn() {}, agent };
  try {
    saveNetworkConfiguration(f.config, network('http://project.example:8080'));
    expect(await new PiProvider(f.config).run(run)).toBe('done');
    expect(await new CodexProvider(f.config).run({ ...run, agent: { ...agent, agent: 'codex' } })).toBe('done');
    expect((await discoverAgentModels(f.config, 'pi')).source).toBe('cli');
    expect((await discoverAgentModels(f.config, 'codex')).source).toBe('cli');
    const envs = fs.readFileSync(observed, 'utf8').trim().split('\n').map(JSON.parse);
    expect(envs).toHaveLength(4);
    for (const env of envs) { expect(env.HTTP_PROXY).toBe('http://project.example:8080/'); expect(env.http_proxy).toBe(env.HTTP_PROXY); expect(env.ALL_PROXY).toBe(''); expect(env.NO_PROXY).toContain('127.0.0.1'); }
    for (const env of envs.slice(0, 2)) { expect(env.https_proxy).toBe('http://worker.example'); expect(env.HTTPS_PROXY).toBe(env.https_proxy); }
    for (const env of envs.slice(2)) expect(env.HTTPS_PROXY).toBe('http://project.example:8080/');
    saveNetworkConfiguration(f.config, { version: 1, mode: 'direct', proxy_url: null, no_proxy: [] });
    await discoverAgentModels(f.config, 'pi');
    const last = JSON.parse(fs.readFileSync(observed, 'utf8').trim().split('\n').at(-1)); expect(last.HTTP_PROXY).toBe(''); expect(last.HTTPS_PROXY).toBe('');
  } finally { await f.close(); }
});
