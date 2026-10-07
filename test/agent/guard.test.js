import { test, expect } from 'bun:test';
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, temp, until } from '../helpers.js';
import { PiProvider } from '../../src/agent/provider.js';
import { managedPiRun } from './managed-runtime-fixture.js';

const GUARD = path.resolve(import.meta.dir, '../../bin/lush-agent-guard');

function writeScript(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env bun\n${body}\n`, { mode: 0o755 });
  return file;
}

// Fake agent that writes a pulse file until it is killed. It ignores SIGTERM so only the
// guard's group SIGKILL can stop it, which is what these tests must prove.
function pulseAgent(dir, name, pulse, { ignoreSignals = true, exitAfterMs = 0, exitCode = 0 } = {}) {
  return writeScript(dir, name, `
import fs from 'node:fs';
const pulse = ${JSON.stringify(pulse)};
fs.writeFileSync(pulse + '.pid', String(process.pid));
try { fs.appendFileSync(pulse, '.'); } catch {}
setInterval(() => { try { fs.appendFileSync(pulse, 'x'); } catch {} }, 15);
${ignoreSignals ? "process.on('SIGTERM', () => {});" : ''}
${exitAfterMs ? `setTimeout(() => process.exit(${exitCode}), ${exitAfterMs});` : ''}
`);
}

// Mimics the daemon: owns the guard's stdin pipe, records both pids, then either stays alive
// (to be signalled) or exits by itself with the given status.
function hostScript(dir) {
  return writeScript(dir, 'host.mjs', `
import cp from 'node:child_process';
import fs from 'node:fs';
const [guard, infoFile, mode, ...rest] = process.argv.slice(2);
const child = cp.spawn(process.execPath, [guard, ...rest], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});
fs.writeFileSync(infoFile, JSON.stringify({ host: process.pid, guard: child.pid }));
if (mode === 'stay') setInterval(() => {}, 1000);
else setTimeout(() => process.exit(Number(mode)), 350);
`);
}

const size = file => { try { return fs.statSync(file).size; } catch { return 0; } };
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const groupAlive = pgid => { if (!pgid) return false; try { process.kill(-pgid, 0); return true; } catch { return false; } };

async function waitStableSize(file, { window = 400, timeout = 6000 } = {}) {
  const end = Date.now() + timeout;
  let last = size(file), changedAt = Date.now();
  while (Date.now() < end) {
    await Bun.sleep(25);
    const now = size(file);
    if (now !== last) { last = now; changedAt = Date.now(); continue; }
    if (Date.now() - changedAt >= window) return last;
  }
  throw new Error(`pulse ${file} did not stop within ${timeout}ms`);
}

function startHost(dir, command, pulse, mode) {
  const infoFile = path.join(dir, `host-info-${Math.random().toString(36).slice(2)}.json`);
  const host = cp.spawn(process.execPath, [hostScript(dir), GUARD, infoFile, mode, command, pulse],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  return { host, infoFile };
}

async function waitForHost(infoFile, pulse) {
  await until(() => fs.existsSync(infoFile) && fs.existsSync(`${pulse}.pid`) && size(pulse) > 0, 6000);
  return { info: JSON.parse(fs.readFileSync(infoFile, 'utf8')), agentPid: Number(fs.readFileSync(`${pulse}.pid`, 'utf8')) };
}

async function hostDeathScenario({ signal, mode = 'stay' }) {
  const dir = temp();
  const pulse = path.join(dir, 'pulse');
  const agent = pulseAgent(dir, 'agent.mjs', pulse);
  const { host, infoFile } = startHost(dir, agent, pulse, mode);
  try {
    const { info, agentPid } = await waitForHost(infoFile, pulse);
    expect(alive(agentPid)).toBe(true);
    const before = size(pulse);
    await until(() => size(pulse) > before, 2000);
    if (signal) process.kill(host.pid, signal);
    await new Promise(resolve => host.on('exit', resolve));
    await waitStableSize(pulse);
    await until(() => !alive(agentPid), 4000);
    expect(alive(agentPid)).toBe(false);
    expect(groupAlive(info.guard)).toBe(false);
  } finally {
    try { host.kill('SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a SIGKILLed host makes the guard stop the wrapped agent and its own process group', async () => {
  await hostDeathScenario({ signal: 'SIGKILL' });
});

test('a SIGTERMed host makes the guard stop the wrapped agent', async () => {
  await hostDeathScenario({ signal: 'SIGTERM' });
});

test('an abnormally exiting host makes the guard stop the wrapped agent', async () => {
  await hostDeathScenario({ mode: '3' });
});

test('the guard only kills its own process group and leaves unrelated groups writing', async () => {
  const dir = temp();
  const victimPulse = path.join(dir, 'victim');
  const bystanderPulse = path.join(dir, 'bystander');
  const victim = pulseAgent(dir, 'victim.mjs', victimPulse);
  const bystander = pulseAgent(dir, 'bystander.mjs', bystanderPulse);
  const standalone = cp.spawn(process.execPath, [bystander], { detached: true, stdio: 'ignore' });
  const { host, infoFile } = startHost(dir, victim, victimPulse, 'stay');
  try {
    const { info, agentPid } = await waitForHost(infoFile, victimPulse);
    await until(() => fs.existsSync(`${bystanderPulse}.pid`) && size(bystanderPulse) > 0, 6000);
    const bystanderPid = Number(fs.readFileSync(`${bystanderPulse}.pid`, 'utf8'));
    process.kill(host.pid, 'SIGKILL');
    await new Promise(resolve => host.on('exit', resolve));
    await waitStableSize(victimPulse);
    await until(() => !alive(agentPid), 4000);
    expect(alive(agentPid)).toBe(false);
    expect(groupAlive(info.guard)).toBe(false);
    // An independent process in its own group must keep writing after the cleanup.
    const mark = size(bystanderPulse);
    await until(() => size(bystanderPulse) > mark, 2500);
    expect(alive(bystanderPid)).toBe(true);
  } finally {
    try { process.kill(-standalone.pid, 'SIGKILL'); } catch { try { standalone.kill('SIGKILL'); } catch { /* gone */ } }
    try { host.kill('SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function profile() {
  return { agent: 'pi', model: '', thinking: '', default_prompt: '', append_prompt: '',
    extensions: [], skills: [], soft_budget: {} };
}
function runOptions(f, overrides = {}) {
  return managedPiRun({ task: { id: 7, role: 'worker', goal: 'guard test', input_id: null },
    context: { invocation: { run_id: 21 } }, messages: [], messagesPage: null, cwd: f.root, token: 't',
    signal: new AbortController().signal, onSpawn: () => {}, agent: profile(), ...overrides });
}

test('guarded invocations preserve stdout, stderr and the exit code for success and failure', async () => {
  const dir = temp();
  const ok = writeScript(dir, 'ok.mjs', `process.stdout.write('result-ok'); process.stderr.write('noise'); process.exit(0);`);
  const bad = writeScript(dir, 'bad.mjs', `process.stderr.write('boom-detail'); process.exit(7);`);
  const f = fixture(null, { LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: ok });
  await repo(f.root);
  try {
    const provider = new PiProvider(f.config);
    let spawned = null, delivered = 0;
    const onInputDelivered = () => { delivered++; };
    expect(await provider.run(runOptions(f, { onSpawn: pid => { spawned = pid; }, onInputDelivered }))).toBe('result-ok');
    expect(delivered).toBe(1);
    await until(() => !groupAlive(spawned), 3000);
    expect(groupAlive(spawned)).toBe(false);
    f.config.env.LUSH_PI_COMMAND = bad;
    await expect(provider.run(runOptions(f, { onInputDelivered }))).rejects.toThrow('managed Pi invocation failed');
    expect(delivered).toBe(2); // failure after startup still received the input
    f.config.env.LUSH_PI_COMMAND = path.join(dir, 'missing-agent');
    await expect(provider.run(runOptions(f, { onInputDelivered }))).rejects.toThrow('managed Pi invocation failed');
    expect(delivered).toBe(2); // starting the guard alone is not a delivery
  } finally { await f.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a wrapper that exits early leaves no background writer behind its guard group', async () => {
  const dir = temp();
  const pulse = path.join(dir, 'pulse');
  const writer = pulseAgent(dir, 'writer.mjs', pulse);
  const wrapper = writeScript(dir, 'wrapper.mjs', `
import cp from 'node:child_process';
import fs from 'node:fs';
const writerPath = ${JSON.stringify(writer)};
const child = cp.spawn(process.execPath, [writerPath], { stdio: ['ignore', 'inherit', 'inherit'] });
fs.writeFileSync(${JSON.stringify(pulse)} + '.writer', String(child.pid));
process.stdout.write('wrapper-done');
process.exit(0);
`);
  const f = fixture(null, { LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: wrapper });
  await repo(f.root);
  try {
    const provider = new PiProvider(f.config);
    expect(await provider.run(runOptions(f, { task: { id: 8, role: 'worker', goal: 'wrapper', input_id: null } })))
      .toBe('wrapper-done');
    const writerPid = Number(fs.readFileSync(`${pulse}.writer`, 'utf8'));
    await waitStableSize(pulse);
    await until(() => !alive(writerPid), 4000);
    expect(alive(writerPid)).toBe(false);
  } finally { await f.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('aborting a guarded invocation kills the group even when the agent ignores SIGTERM', async () => {
  const dir = temp();
  const pulse = path.join(dir, 'pulse');
  const agent = pulseAgent(dir, 'stubborn.mjs', pulse);
  const f = fixture(null, { LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: agent });
  await repo(f.root);
  try {
    const provider = new PiProvider(f.config);
    const controller = new AbortController();
    const promise = provider.run(runOptions(f, {
      task: { id: 9, role: 'worker', goal: 'stubborn', input_id: null }, signal: controller.signal }));
    await until(() => fs.existsSync(`${pulse}.pid`) && size(pulse) > 0, 6000);
    const agentPid = Number(fs.readFileSync(`${pulse}.pid`, 'utf8'));
    expect(alive(agentPid)).toBe(true);
    controller.abort(new Error('cancelled by test'));
    await expect(promise).rejects.toThrow('cancelled by test');
    await waitStableSize(pulse);
    await until(() => !alive(agentPid), 4000);
    expect(alive(agentPid)).toBe(false);
  } finally { await f.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
