import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, until } from './helpers.js';
import { fetch } from './web/harness.js';
import { startPreview } from '../src/core/preview.js';

test('managed preview substitutes argv port, bounds logs and reports command failure', async () => {
  const root = temp(); let preview;
  try {
    preview = await startPreview({ cwd: root, directory: root,
      command: [process.execPath, '-e', `console.log('x'.repeat(100000));Bun.serve({hostname:'127.0.0.1',port:Number(process.argv.at(-1)),fetch:()=>new Response('demo')});`, '{port}'] });
    expect(await (await fetch(preview.url)).text()).toBe('demo');
    expect(fs.statSync(preview.log_path).size).toBeLessThanOrEqual(65536);
    expect(preview.command.at(-1)).toBe(String(preview.port));
    await preview.stop();
    await expect(fetch(preview.url)).rejects.toThrow();
    await expect(startPreview({ cwd: root, directory: root, command: ['lush-does-not-exist-command'] })).rejects.toThrow('did not listen');
  } finally { await preview?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
}, 10000);

test('daemon-like parent killed abruptly closes supervisor stdin and reaps preview process group', async () => {
  const root = temp(); let child, url;
  try {
    const ready = path.join(root, 'ready.json');
    const module = new URL('../src/core/preview.js', import.meta.url).href;
    const command = [process.execPath, '-e', `Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>new Response('alive')});`];
    const script = `import fs from 'node:fs';import {startPreview} from ${JSON.stringify(module)};
      const p=await startPreview(${JSON.stringify({ cwd: root, directory: root, command })});
      fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({url:p.url}));setInterval(()=>{},1000);`;
    child = Bun.spawn([process.execPath, '-e', script], { cwd: root, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    await until(() => fs.existsSync(ready));
    url = JSON.parse(fs.readFileSync(ready, 'utf8')).url;
    expect((await fetch(url)).ok).toBe(true);
    child.kill('SIGKILL'); await child.exited;
    let stopped = false;
    for (let i = 0; i < 100; i++) {
      try { await fetch(url); } catch { stopped = true; break; }
      await Bun.sleep(30);
    }
    expect(stopped).toBe(true);
  } finally { child?.kill(); if (child) await child.exited; fs.rmSync(root, { recursive: true, force: true }); }
}, 10000);
