import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { codeFingerprint, codeIdentity, codeMismatch, codeVersion } from '../src/identity.js';

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
