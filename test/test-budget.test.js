import { test, expect } from 'bun:test';
import fs from 'node:fs';

const config = Bun.TOML.parse(fs.readFileSync(new URL('../bunfig.toml', import.meta.url), 'utf8'));
const { scripts } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function testArgs(name) {
  const [runtime, command, ...args] = scripts[name].split(/\s+/);
  expect([runtime, command]).toEqual(['bun', 'test']);
  return args;
}

test('all test entrypoints use the same bounded budget without retries or excluded paths', () => {
  expect(config.test.root).toBe('test');
  expect(testArgs('test')).toEqual(['--parallel=4', '--timeout=20000']);
  expect(testArgs('test:all')).toEqual(testArgs('test'));
  expect(testArgs('test:serial')).toEqual(['--timeout=20000']);
});
