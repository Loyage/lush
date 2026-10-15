import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setup, git } from './convergence-harness.js';

async function ready(options) {
  const f = await setup(options);
  try {
    await f.member('a', { 'a.txt': 'a\n' }); await f.member('b', { 'b.txt': 'b\n' });
    const root = await f.combine(), receipt = await f.prepare(root.tree);
    return { ...f, receipt };
  } catch (error) { f.close(); throw error; }
}

test('exact batch publish changes only target, one single-parent commit, and survives DB-not-settled recovery', async () => {
  const f = await ready();
  try {
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(f.baseline);
    for (const member of f.members) expect(await git(member.workspace, 'rev-parse', 'HEAD^{tree}')).not.toBe(f.receipt.tree);
    const hook = path.join(f.root, '.git', 'hooks', 'reference-transaction');
    fs.writeFileSync(hook, '#!/bin/sh\ntouch hook-ran\n', { mode: 0o755 });
    const watch = await f.workspaces.watchBranch('main');
    await f.apply(f.receipt);
    expect((await f.workspaces.checkWatchedBranch(watch)).explained).toBe(true); f.workspaces.unwatchBranch(watch);
    expect(await git(f.root, 'show', '-s', '--format=%P', 'HEAD')).toBe(f.baseline);
    expect(await git(f.root, 'rev-list', '--count', `${f.baseline}..HEAD`)).toBe('1');
    expect(await git(f.root, 'rev-parse', 'HEAD^{tree}')).toBe(f.receipt.tree);
    expect(await git(f.root, 'status', '--porcelain')).toBe(''); expect(fs.existsSync(path.join(f.root, 'hook-ran'))).toBe(false);
    expect(await f.workspaces.verifyConvergencePublishUnsafe(JSON.parse(JSON.stringify(f.receipt)))).toBe(true);
    for (const member of f.members) expect(await git(member.workspace, 'rev-parse', 'HEAD')).toBe(member.source_commit);
    await expect(f.apply(f.receipt)).rejects.toThrow('moved'); // Never blindly replay.
  } finally { f.close(); }
});
