import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../src/config.js';
import { env, temp } from './helpers.js';

test('runtime settings save, reload and reset active values', () => {
  const root = temp(), options = { project: root, env: env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') }) };
  try {
    const config = new Config(options);
    expect(config.timeout).toBe(10800);
    expect(config.runtimeSettings.get().result_notice).toMatchObject({ value: true, source: 'default' });
    for (const value of ['false', 0, {}]) expect(() => config.configureRuntime({ result_notice: value })).toThrow('boolean');
    config.configureRuntime({ result_notice: false });
    config.configureRuntime({ call_timeout: 60, task_call_limit: 8, max_depth: 5 });
    const restarted = new Config(options);
    expect(restarted.timeout).toBe(60);
    expect(restarted.runtimeSettings.get().result_notice).toMatchObject({ value: false, source: 'device' });
    restarted.configureRuntime({ result_notice: null });
    expect(restarted.runtimeSettings.get().result_notice).toMatchObject({ value: true, source: 'default' });
    expect(restarted.runtimeSettings.get()).toMatchObject({
      task_call_limit: { value: 8, source: 'device' }, max_depth: { value: 5, source: 'device' },
    });
    restarted.configureRuntime({ call_timeout: null });
    expect(restarted.timeout).toBe(10800);
    expect(restarted.runtimeSettings.get().task_call_limit.value).toBe(8);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
