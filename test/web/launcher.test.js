import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from '../helpers.js';
import { fetch } from './harness.js';
import { createProjectHost, startWeb } from '../../src/ui/web/server.js';
import { launcherStateFile, readLauncherState } from '../../src/ui/launcher.js';

function opener(calls) {
  return async project => {
    calls.push(project);
    return { config: { project, home: path.join(project, '.lush') }, client: {} };
  };
}

test('并行界面都写全局缓存时，最后关闭的实例重新记下自己所在的项目', async () => {
  const firstRoot = temp(), secondRoot = temp(), global = temp();
  const env = { ...process.env, LUSH_GLOBAL_CONFIG: global };
  try {
    const first = createProjectHost(null, { env, openProject: opener([]) });
    const second = createProjectHost(null, { env, openProject: opener([]) });
    await first.select(firstRoot);
    await second.select(secondRoot);
    expect(readLauncherState(env).last_project).toBe(fs.realpathSync(secondRoot));
    first.rememberCurrent();
    expect(readLauncherState(env).last_project).toBe(fs.realpathSync(firstRoot));
  } finally {
    for (const dir of [firstRoot, secondRoot, global]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('无项目 Web 首次要求选择绝对路径，并在下一次启动自动恢复', async () => {
  const root = temp();
  const global = temp();
  const env = { ...process.env, LUSH_GLOBAL_CONFIG: global };
  const calls = [];
  const web = startWeb(null, 0, { env, openProject: opener(calls) });
  const url = `http://127.0.0.1:${web.port}`;
  try {
    expect((await fetch(url + '/')).status).toBe(200);
    expect(await (await fetch(url + '/')).text()).toContain('id="project-gate"');
    expect((await fetch(url + '/project-picker.js')).status).toBe(200);
    expect(await (await fetch(url + '/api/launcher')).json()).toMatchObject({ mode: 'launcher', project: null, last_project: null });
    const relative = await fetch(url + '/api/launcher/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'relative' }) });
    expect(relative.status).toBe(400);

    const selected = await fetch(url + '/api/launcher/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: root }) });
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({ mode: 'launcher', project: fs.realpathSync(root), last_project: fs.realpathSync(root) });
    expect(calls).toEqual([fs.realpathSync(root)]);
    expect(JSON.parse(fs.readFileSync(launcherStateFile(env), 'utf8')).last_project).toBe(fs.realpathSync(root));
  } finally { web.stop(true); }

  const restoredCalls = [];
  const restored = startWeb(null, 0, { env, openProject: opener(restoredCalls) });
  try {
    const status = await (await fetch(`http://127.0.0.1:${restored.port}/api/launcher`)).json();
    expect(status.project).toBe(fs.realpathSync(root));
    expect(restoredCalls).toEqual([fs.realpathSync(root)]);
  } finally {
    restored.stop(true);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(global, { recursive: true, force: true });
  }
});
