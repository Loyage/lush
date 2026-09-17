import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { codeFingerprint, codeIdentity, codeMismatch, codeVersion } from '../src/identity.js';
import { formatDaemon } from '../src/cli/main.js';

const ROOT = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

describe('code identity', () => {
  test('describes this checkout, not a home', () => {
    const identity = codeIdentity();
    expect(identity.code_dir).toBe(ROOT);
    expect(identity.version).toBe(codeVersion());
    expect(identity.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    // Stable across calls: both sides must be able to compare it.
    expect(codeFingerprint()).toBe(identity.fingerprint);
    expect(codeIdentity()).toEqual(identity);
  });

  test('compares a daemon identity with the local one', () => {
    const local = codeIdentity();
    expect(codeMismatch(local, local)).toBeNull();
    expect(codeMismatch({ code_dir: local.code_dir, fingerprint: local.fingerprint }, local)).toBeNull();
    expect(codeMismatch({ ...local, fingerprint: 'ffffffffffff' }, local)).toContain('older start of this checkout');
    expect(codeMismatch({ ...local, code_dir: '/elsewhere/lush' }, local)).toContain('different checkout');
    // A daemon from before this feature reports nothing at all.
    expect(codeMismatch({ daemon_pid: 1 }, local)).toContain('did not report');
    expect(codeMismatch(null, local)).toContain('did not report');
  });
});

describe('daemon text output', () => {
  test('shows identity fields and the CLI view, hiding nested objects', () => {
    const text = formatDaemon({
      started: true,
      daemon_pid: 42,
      home: '/state/lush',
      code_dir: '/repo',
      fingerprint: '0123456789ab',
      uptime_seconds: 3,
      cli: { home: '/state/lush', code_dir: '/repo', fingerprint: '0123456789ab', code_match: true },
    });
    const lines = text.split('\n');
    expect(lines.length).toBe(10); // started + 5 daemon fields + 4 flattened cli fields
    expect(text).toMatch(/^daemon_pid\s+42$/m);
    expect(text).toMatch(/^home\s+\/state\/lush$/m);
    expect(text).toMatch(/^fingerprint\s+0123456789ab$/m);
    expect(text).toMatch(/^cli\.code_match\s+true$/m);
    // The nested `cli` object is flattened, never printed as a blob.
    expect(text).not.toMatch(/^cli\s/m);
    expect(text).not.toContain('{');
  });
});
