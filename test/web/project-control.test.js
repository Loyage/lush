import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { temp, env, gate } from '../helpers.js';
import { createProjectHost } from '../../src/host/project-host.js';
import { projectRouteId, writeLauncherState, readLauncherState } from '../../src/host/registry.js';

function setup(overrides = {}) {
  const root = temp(), global = temp(), environment = env({ LUSH_GLOBAL_CONFIG: global });
  const calls = [], binding = { config: { project: root, home: `${root}/.lush` }, client: {} };
  writeLauncherState(root, environment);
  const host = createProjectHost(null, { env: environment,
    openProject: async project => { calls.push(['start', project]); return binding; },
    attachProject: async project => { calls.push(['attach', project]); return binding; },
    stopProject: async config => { calls.push(['stop', config.project]); return { stopped: true, project: config.project }; },
    ...overrides });
  return { root, global, environment, host, calls, binding, id: projectRouteId(root),
    close() { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(global, { recursive: true, force: true }); } };
}

test('API attachment does not launch daemon, including after explicit stop and a new Host', async () => {
  const f = setup();
  try {
    expect((await f.host.status()).project_control).toBe(true);
    await f.host.openRoute(f.id);
    expect(f.calls).toEqual([['attach', f.root]]);
    await f.host.start(f.id);
    await f.host.stop(f.id);
    await f.host.openRoute(f.id);
    await f.host.openRoute(f.id);
    expect(f.calls).toEqual([['attach', f.root], ['start', f.root], ['stop', f.root], ['attach', f.root]]);
    let starts = 0;
    const second = createProjectHost(null, { env: f.environment, openProject: async () => { starts++; return f.binding; } });
    await second.openRoute(f.id); // default attachment must never use the injected starter
    expect(starts).toBe(0);
    expect(readLauncherState(f.environment).projects).toEqual([f.root]);
    await f.host.start(f.id);
    expect(f.calls.at(-1)).toEqual(['start', f.root]);
  } finally { f.close(); }
});

test('explicit start is single-flight and cannot race stop or remove', async () => {
  const g = gate(); let calls = 0, binding;
  const f = setup({ openProject: async () => { calls++; await g.promise; return binding; } });
  binding = f.binding;
  try {
    const first = f.host.start(f.id), second = f.host.start(f.id);
    await expect(f.host.stop(f.id)).rejects.toThrow('正在');
    expect(() => f.host.remove(f.id)).toThrow('正在');
    g.resolve();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  } finally { g.resolve(); f.close(); }
});

test('explicit start waiting on passive attachment still starts, while readers never do', async () => {
  const g = gate(); let binding;
  const f = setup({ attachProject: async () => { await g.promise; return binding; } }); binding = f.binding;
  try {
    const attached = f.host.openRoute(f.id), started = f.host.start(f.id);
    g.resolve(); await Promise.all([attached, started]);
    expect(f.calls).toEqual([['start', f.root]]);
  } finally { g.resolve(); f.close(); }
});

test('busy stop preserves binding and identity; stop/remove cannot race or accept unknown IDs', async () => {
  let reject = true;
  const g = gate(), f = setup({ stopProject: async () => { if (reject) throw new Error('有活动 Agent'); await g.promise; return { stopped: true }; } });
  try {
    await f.host.start(f.id);
    await expect(f.host.stop(f.id)).rejects.toThrow('活动 Agent');
    expect(await f.host.openRoute(f.id)).toBe(f.binding);
    reject = false;
    const stopping = f.host.stop(f.id);
    await expect(f.host.start(f.id)).rejects.toThrow('正在停止');
    await expect(f.host.stop(f.id)).rejects.toThrow('正在');
    await expect(f.host.openRoute(f.id)).rejects.toThrow('正在停止');
    expect(() => f.host.remove(f.id)).toThrow('正在');
    g.resolve(); await stopping;
    for (const id of ['0'.repeat(16), '../project', undefined, f.root]) {
      await expect(f.host.start(id)).rejects.toThrow('身份');
      await expect(f.host.stop(id)).rejects.toThrow('身份');
    }
    f.host.remove(f.id);
    expect(readLauncherState(f.environment).projects).toEqual([]);
  } finally { g.resolve(); f.close(); }
});

test('backend overview publishes validated process PID and safe unreachable diagnostics without changing Worker facts', async () => {
  const f = setup(); let pid = 1234;
  f.binding.client.request = async method => {
    expect(method).toBe('system.summary');
    return { project: f.root, pid, agents_total: 2, notices: 3, pending_merges: [17], credential: 'never project this' };
  };
  try {
    await f.host.start(f.id);
    const [running] = await f.host.projects(); expect(running.running).toBe(true);
    expect(running.summary).toMatchObject({ pid: 1234, agents_total: 2, notices: 3, pending_merges: 1 });
    expect(running.summary.credential).toBeUndefined();
    pid = 'invalid'; expect((await f.host.projects())[0].summary.pid).toBeUndefined();
    f.binding.client.request = async () => { throw Error('private error payload'); };
    const failed = (await f.host.projects())[0]; expect(failed.running).toBe(false); expect(failed.error).toContain('未确认');
    expect(failed.error).not.toContain('private error'); expect(f.calls).toEqual([['start', f.root]]);
  } finally { f.close(); }
});

test('public project controls honor only allowed project registry', async () => {
  const f = setup({ allowedProjects: [] });
  try {
    await expect(f.host.start(f.id)).rejects.toThrow('身份');
    await expect(f.host.stop(f.id)).rejects.toThrow('身份');
    await expect(f.host.select(f.root)).rejects.toThrow('白名单');
    expect(f.calls).toEqual([]);
  } finally { f.close(); }
});
