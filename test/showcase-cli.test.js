import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from './helpers.js';
import { run } from '../src/cli/commands/showcase.js';

test('showcase CLI forwards branch/baseline, list filters and user stop; preview sends structured argv only', async () => {
  const calls = [], root = temp();
  const ctx = { client: { request: async (method, params) => { calls.push({ method, params }); return { id: 7 }; } } };
  try {
    expect(await run('showcase', ['start','feature','--baseline','main'], ctx)).toEqual({ id: 7 });
    expect(calls.at(-1)).toEqual({ method: 'showcase.start', params: { branch: 'feature', baseline: 'main' } });
    await run('showcase', ['list','--branch','feature'], ctx);
    expect(calls.at(-1)).toEqual({ method: 'showcase.list', params: { branch: 'feature' } });
    await run('showcase', ['stop','7'], ctx);
    expect(calls.at(-1)).toEqual({ method: 'showcase.stop', params: { id: 7 } });
    const file = path.join(root, 'preview.json');
    const spec = { command: ['bun','run','dev','--port','{port}'], path: '/demo' };
    fs.writeFileSync(file, JSON.stringify(spec));
    await run('showcase', ['preview','--file',file], ctx);
    expect(calls.at(-1)).toEqual({ method: 'showcase.preview', params: spec });
    fs.writeFileSync(file, JSON.stringify({ ...spec, id: 2 }));
    await expect(run('showcase', ['preview','--file',file], ctx)).rejects.toThrow('command and path only');
    await expect(run('showcase', ['start','feature','extra'], ctx)).rejects.toThrow();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
