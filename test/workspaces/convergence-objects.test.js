import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setup, git } from './convergence-harness.js';

async function unchanged(f, refs, index) {
  expect(await git(f.root, 'show-ref', '--heads')).toBe(refs);
  expect(await git(f.root, 'write-tree')).toBe(index);
  expect(await git(f.root, 'status', '--porcelain')).toBe('');
}

test('same-file disjoint changes merge as immutable objects, without touching any ref or index', async () => {
  const f = await setup({ initial: { 'file.txt': 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n' } });
  try {
    await f.member('first', { 'file.txt': 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\n' });
    await f.member('last', { 'file.txt': 'one\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n' });
    const refs = await git(f.root, 'show-ref', '--heads'), index = await git(f.root, 'write-tree');
    const root = await f.combine(); expect(root.conflict).toBe(false);
    expect(await git(f.root, 'show', `${root.commit}:file.txt`)).toBe('ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN');
    await unchanged(f, refs, index);
    for (const member of f.members) expect(await git(member.workspace, 'status', '--porcelain')).toBe('');
  } finally { f.close(); }
});

test('real textual conflict creates a seed that retains both inputs but never a real conflict index', async () => {
  const f = await setup();
  try {
    await f.member('one', { 'file.txt': 'one\n' }); await f.member('two', { 'file.txt': 'two\n' });
    const refs = await git(f.root, 'show-ref', '--heads'), index = await git(f.root, 'write-tree');
    const root = await f.combine(); expect(root.conflict).toBe(true); expect(root.conflicts).toContain('file.txt');
    expect(await git(f.root, 'show', `${root.commit}:file.txt`)).toContain('<<<<<<<');
    expect(await git(f.root, 'show', '-s', '--format=%P', root.commit)).toBe(`${root.left} ${root.right}`);
    await unchanged(f, refs, index); expect(await git(f.root, 'ls-files', '-u')).toBe('');
  } finally { f.close(); }
});

test('binary, rename/delete conflicts remain explicit; rename plus a peer addition works', async () => {
  const f = await setup();
  try {
    const a = await f.member('rename'); await git(a.workspace, 'mv', 'file.txt', 'renamed.txt');
    await git(a.workspace, 'commit', '-m', 'rename'); a.source_commit = await git(a.workspace, 'rev-parse', 'HEAD');
    const b = await f.member('peer', { 'peer.txt': 'peer\n' });
    const good = await f.combine([a, b]); expect(good.conflict).toBe(false);
    expect(await git(f.root, 'show', `${good.commit}:renamed.txt`)).toBe('base');
    expect(await git(f.root, 'show', `${good.commit}:peer.txt`)).toBe('peer');
    const c = await f.member('delete', { 'file.txt': null });
    const conflict = await f.combine([a, c]); expect(conflict.conflict).toBe(true);
    fs.writeFileSync(path.join(a.workspace, 'binary.bin'), Buffer.from([0, 1, 2]));
    await git(a.workspace, 'add', '.'); await git(a.workspace, 'commit', '-m', 'binary base');
    const binaryBase = await git(a.workspace, 'rev-parse', 'HEAD');
    const d = await f.member('binary1', { 'binary.bin': Buffer.from([0, 3, 4]) }, binaryBase);
    const e = await f.member('binary2', { 'binary.bin': Buffer.from([0, 5, 6]) }, binaryBase);
    const binary = await f.workspaces.mergeConvergenceObjects({ base: binaryBase, left: d.source_commit,
      right: e.source_commit, message: 'binary conflict' });
    expect(binary.conflict).toBe(true); expect(binary.conflicts).toContain('binary.bin');
    expect(await git(f.root, 'status', '--porcelain')).toBe('');
  } finally { f.close(); }
});

test('without an equivalent source base Git handles multiple real merge bases', async () => {
  const f = await setup();
  try {
    const a = await f.member('a', { 'a.txt': 'a\n' }), b = await f.member('b', { 'b.txt': 'b\n' });
    const merged = await f.workspaces.mergeConvergenceObjects({ left: a.source_commit, right: b.source_commit, message: 'AB' });
    const reverse = await git(f.root, 'commit-tree', merged.tree, '-p', b.source_commit, '-p', a.source_commit, '-m', 'BA');
    const left = await git(f.root, 'commit-tree', merged.tree, '-p', merged.commit, '-m', 'left');
    const right = await git(f.root, 'commit-tree', merged.tree, '-p', reverse, '-m', 'right');
    const bases = (await git(f.root, 'merge-base', '--all', left, right)).split('\n'); expect(bases.length).toBe(2);
    const result = await f.workspaces.mergeConvergenceObjects({ left, right, message: 'criss cross' });
    expect(result.conflict).toBe(false); expect(result.tree).toBe(merged.tree);
  } finally { f.close(); }
});

test('fixed-object boundaries reject rev expressions, noncommit hashes and invalid parents', async () => {
  const f = await setup();
  try {
    const tree = await git(f.root, 'rev-parse', 'HEAD^{tree}');
    await expect(f.workspaces.mergeConvergenceObjects({ left: 'HEAD', right: f.baseline, message: 'x' })).rejects.toThrow('fixed');
    await expect(f.workspaces.mergeConvergenceObjects({ left: tree, right: f.baseline, message: 'x' })).rejects.toThrow();
    await expect(f.workspaces.mergeConvergenceObjects({ left: f.baseline, right: f.baseline, parents: [], message: 'x' })).rejects.toThrow('parents');
  } finally { f.close(); }
});

test('large conflict listings are streamed, bounded and preserve NUL-delimited unusual filenames', async () => {
  const initial = {}, left = {}, right = {};
  for (let i = 0; i < 102; i++) {
    const name = i === 0 ? '000\nconflict.txt' : `conflict-${String(i).padStart(3, '0')}.txt`;
    initial[name] = 'base\n'; left[name] = 'left\n'; right[name] = 'right\n';
  }
  const f = await setup({ initial });
  try {
    await f.member('left', left); await f.member('right', right);
    const root = await f.combine();
    expect(root.conflict).toBe(true); expect(root.conflicts.length).toBe(100);
    expect(root.conflicts).toContain('000\nconflict.txt');
    expect(await git(f.root, 'status', '--porcelain')).toBe('');
  } finally { f.close(); }
});
