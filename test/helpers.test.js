import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env, temp } from './helpers.js';

async function child(script, environment) {
  const proc = Bun.spawn([process.execPath, '-e', script], { env: environment, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (code) throw new Error(`helper probe exited ${code}: ${stderr}\n${stdout}`);
  return JSON.parse(stdout);
}

test('test environment isolates home and Git configuration without mutating the caller', () => {
  const before = { ...process.env };
  const isolated = env();
  expect(isolated.HOME).not.toBe(process.env.HOME);
  expect(fs.statSync(isolated.HOME).isDirectory()).toBe(true);
  expect(isolated.XDG_CONFIG_HOME).toBe(isolated.HOME);
  expect(isolated.GIT_CONFIG_NOSYSTEM).toBe('1');
  expect(isolated.GIT_CONFIG_GLOBAL).toBe(os.devNull);
  expect(isolated.GIT_CONFIG_SYSTEM).toBe(os.devNull);
  expect(env({ HOME: '/synthetic/home', GIT_CONFIG_GLOBAL: '/synthetic/gitconfig' })).toMatchObject({
    HOME: '/synthetic/home', GIT_CONFIG_GLOBAL: '/synthetic/gitconfig',
  });
  expect({ ...process.env }).toEqual(before);
});

test('helper repo and fixture Git ignore synthetic host hooks, signing and injected repository state', async () => {
  const root = temp();
  try {
    const hooks = path.join(root, 'hooks'); fs.mkdirSync(hooks);
    const marker = path.join(hooks, 'ran');
    fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\ntouch "$(dirname "$0")/ran"\nexit 42\n', { mode: 0o700 });
    const global = path.join(root, 'gitconfig');
    fs.writeFileSync(global, `[core]\n hooksPath = ${hooks}\n[commit]\n gpgSign = true\n[gpg]\n program = /nonexistent-test-signing-command\n`);
    const helper = new URL('./helpers.js', import.meta.url).href;
    const script = `
      import fs from 'node:fs';
      import path from 'node:path';
      import { env, fixture, repo, git } from ${JSON.stringify(helper)};
      const before = { ...process.env };
      const f = fixture();
      try {
        await repo(f.root);
        await f.project.workspaces.git(f.root, 'commit', '--allow-empty', '-m', 'fixture commit');
        const explicit = env({ GIT_CONFIG_GLOBAL: ${JSON.stringify(global)} });
        const proc = Bun.spawn(['git', '-C', f.root, 'config', '--get', 'core.hooksPath'], { env: explicit, stdout: 'pipe', stderr: 'pipe' });
        const configured = (await new Response(proc.stdout).text()).trim();
        if (await proc.exited) throw new Error('explicit config unavailable');
        console.log(JSON.stringify({ subject: await git(f.root, 'log', '-1', '--format=%s'),
          configured, unchanged: JSON.stringify(before) === JSON.stringify({ ...process.env }), home: env().HOME }));
      } finally { await f.close(); }
    `;
    // Pollution exists only in this child; no concurrently running test sees it.
    const result = await child(script, { ...env(), HOME: root, XDG_CONFIG_HOME: root,
      GIT_CONFIG_GLOBAL: global, GIT_CONFIG_SYSTEM: global, GIT_CONFIG_NOSYSTEM: '0',
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks,
      GIT_CONFIG_KEY_1: 'commit.gpgSign', GIT_CONFIG_VALUE_1: 'true',
      GIT_CONFIG_PARAMETERS: "'commit.gpgSign=true'", GIT_DIR: path.join(root, 'missing-git'),
      GIT_INDEX_FILE: path.join(root, 'unwanted-index'), GIT_WORK_TREE: root });
    expect(result.subject).toBe('fixture commit');
    expect(result.configured).toBe(hooks);
    expect(result.unchanged).toBe(true);
    expect(fs.existsSync(result.home)).toBe(false); // Child exit cleaned its test home.
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(root, 'unwanted-index'))).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
