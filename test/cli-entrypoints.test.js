import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_CAPABILITIES } from '../src/agent/capabilities.js';
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
    expect(JSON.parse(local.out).map(entry => entry.id)).toEqual(AGENT_CAPABILITIES.map(entry => entry.id));
    const source = await invoke(process.execPath, ['run', 'lushw', '--help'], root);
    expect(source.code, source.err).toBe(0);
    expect(source.out).toContain('lushw [--project PATH]');
    const management = await invoke(path.join(root, 'bin/lush'), ['--help'], cwd);
    expect(management.code, management.err).toBe(0);
    expect(management.out).toContain('lush [--project PATH]');
    expect(management.out).toContain('order');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
