import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import cp from 'node:child_process';
import { readSSHConfig } from '../../src/ui/desktop/ssh-config.js';

function fixture(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-ssh-config-'));
  const root = path.join(home, '.ssh'); fs.mkdirSync(root);
  const write = (name, text) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  try { run({ home, root, write, read: () => readSSHConfig({ home }) }); }
  finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test('missing user config is an empty picker, with no persistence or SSH execution', () => fixture(({ root, read }) => {
  expect(read()).toEqual({ hosts: [], warnings: [] }); expect(fs.readdirSync(root)).toEqual([]);
}));

test('static Host aliases support comments, quotes, equals, CRLF, multiple names and stable deduplication', () => fixture(({ write, read }) => {
  write('config', '# comment\r\nHost = "production" backup !exclude *.example ?wild [ab]host\r\n  HostName secret.example\r\n  User secret-user\r\n  IdentityFile /secret/key\r\nhOsT production "lab-1"\r\nHost "broken\r\nHost -option user@host https://host ;bad good # comment\n');
  const result = read();
  expect(result.hosts).toEqual(['production', 'backup', 'lab-1', 'good'].map(alias => ({ alias })));
  expect(JSON.stringify(result)).not.toContain('secret'); expect(result.warnings).toHaveLength(1);
}));

test('Include follows SSH user-root relative paths, home and absolute paths, glob order, and cycles', () => fixture(({ home, root, write, read }) => {
  write('config', `Host first\nInclude "parts/*.conf" ~/\.ssh/extra "${root}/absolute" missing\nHost last\n`);
  write('parts/b.conf', 'Host b second\nInclude nested\n');
  write('parts/a.conf', 'Host a\nInclude config\n');
  write('nested', 'Host nested\n'); write('extra', 'Host extra second\n'); write('absolute', 'Host absolute\n');
  const before = fs.readFileSync(path.join(root, 'config'), 'utf8');
  expect(read()).toEqual({ hosts: ['first', 'a', 'b', 'second', 'nested', 'extra', 'absolute', 'last'].map(alias => ({ alias })), warnings: [] });
  expect(fs.readFileSync(path.join(root, 'config'), 'utf8')).toBe(before);
  expect(fs.readdirSync(home)).toEqual(['.ssh']);
}));

test('Include quoting and glob bracket/question components work, and symlinked config stays read-only', () => fixture(({ root, write, read }) => {
  write('actual', 'Include "with spaces/[ab]?.conf"\n');
  write('with spaces/a1.conf', 'Host a1\n'); write('with spaces/b2.conf', 'Host b2\n'); write('with spaces/c3.conf', 'Host c3\n');
  fs.symlinkSync(path.join(root, 'actual'), path.join(root, 'config'));
  expect(read().hosts).toEqual([{ alias: 'a1' }, { alias: 'b2' }]);
  expect(fs.lstatSync(path.join(root, 'config')).isSymbolicLink()).toBe(true);
}));

test('Match exec, ProxyCommand, LocalCommand and dynamic includes are never executed or exposed', () => fixture(({ home, write, read }) => {
  const marker = path.join(home, 'must-not-exist');
  write('config', `Match exec "touch ${marker}"\nInclude conditional\nHost visible\nProxyCommand touch ${marker}\nLocalCommand touch ${marker}\nInclude $(touch ${marker}) %h.conf ~someone/config\n`);
  write('conditional', 'Host conditional-host\n');
  const result = read();
  expect(result.hosts).toEqual([{ alias: 'conditional-host' }, { alias: 'visible' }]);
  expect(result.warnings.length).toBeGreaterThan(0); expect(fs.existsSync(marker)).toBe(false);
  expect(JSON.stringify(result)).not.toContain(marker);
}));

test('unreadable and non-regular Includes report safe partial results without blocking manual connection', () => fixture(({ root, write, read }) => {
  write('config', 'Host useful\nInclude directory\nHost after\n'); fs.mkdirSync(path.join(root, 'directory'));
  const result = read(); expect(result.hosts).toEqual([{ alias: 'useful' }, { alias: 'after' }]); expect(result.warnings).toHaveLength(1);
  if (process.platform !== 'win32') {
    cp.execFileSync('mkfifo', [path.join(root, 'pipe')]); write('config', 'Host useful\nInclude pipe\n');
    expect(read().warnings).toHaveLength(1);
  }
}));

test('file size, Include recursion, alias count and file count are bounded', () => fixture(({ write, read }) => {
  write('config', 'Host useful\nInclude huge\n'); write('huge', '#'.repeat(256 * 1024 + 1));
  expect(read().hosts).toEqual([{ alias: 'useful' }]); expect(read().warnings).toHaveLength(1);
  write('config', 'Include depth0\n'); for (let i = 0; i < 18; i++) write(`depth${i}`, `Host host${i}\nInclude depth${i + 1}\n`);
  expect(read().hosts.length).toBeLessThanOrEqual(16); expect(read().warnings).toHaveLength(1);
  write('config', Array.from({ length: 513 }, (_, i) => `Host server${i}`).join('\n'));
  expect(read().hosts).toHaveLength(512); expect(read().warnings).toHaveLength(1);
  write('config', 'Include many/*\n'); for (let i = 0; i < 130; i++) write(`many/${i}`, `Host many${i}\n`);
  expect(read().hosts.length).toBeLessThanOrEqual(127); expect(read().warnings).toHaveLength(1);
}));

test('growing glob scans and wildcard patterns have bounded work', () => fixture(({ write, read }) => {
  write('config', 'Include lots/*\nHost after\n'); for (let i = 0; i < 4097; i++) write(`lots/${i}`, '');
  expect(read().warnings).toHaveLength(1);
  write('small/' + 'a'.repeat(200), '');
  write('config', `Include small/${'*a'.repeat(60)}z\nHost after\n`);
  expect(read().hosts).toEqual([{ alias: 'after' }]);
}));
