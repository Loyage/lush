import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../src/config.js';
import { RuntimeSettings } from '../src/core/settings.js';
import { assertAllowed } from '../src/rpc/registry.js';
import { fixture, repo, until, gate, env, temp } from './helpers.js';

function controlled() {
  const calls = [];
  return { calls, run(ctx) {
    const done = gate(); calls.push({ ...ctx, done });
    ctx.signal.addEventListener('abort', () => done.resolve('aborted'), { once:true });
    return done.promise;
  } };
}

/** 并发上限可热更新的存储：文件、0600、原子替换、环境默认回退、null 清除、非法值不落盘。 */
test('runtime settings file is atomic, owner-only, and falls back to env defaults per key', () => {
  const root = temp();
  const config = new Config({ project: root, env: env({ LUSH_CONCURRENCY: '6', LUSH_CONTROL_CONCURRENCY: '3' }) });
  config.prepare();
  try {
    const settings = new RuntimeSettings(config);
    const file = path.join(root, '.lush', 'settings.json');
    expect(settings.file).toBe(file);
    // 没有覆盖时读模型给出环境默认值，且不创建文件（不造假值）。
    expect(settings.get()).toEqual({ file,
      concurrency: { value: 6, default: 6, overridden: false },
      control_concurrency: { value: 3, default: 3, overridden: false } });
    expect(fs.existsSync(file)).toBe(false);

    const saved = settings.save({ concurrency: 8 });
    expect(saved.concurrency).toEqual({ value: 8, default: 6, overridden: true });
    expect(saved.control_concurrency).toEqual({ value: 3, default: 3, overridden: false });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, concurrency: 8 });
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    // 原子替换：临时文件不残留，另一处读取立刻看到新值。
    expect(fs.readdirSync(path.join(root, '.lush')).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(new RuntimeSettings(config).get().concurrency.value).toBe(8);

    // 未覆盖的键不因别的键被写而出现在文件里。
    settings.save({ control_concurrency: 5 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, concurrency: 8, control_concurrency: 5 });

    // null 清除该键，回退环境默认。
    const cleared = settings.save({ concurrency: null });
    expect(cleared.concurrency).toEqual({ value: 6, default: 6, overridden: false });
    expect(cleared.control_concurrency).toEqual({ value: 5, default: 3, overridden: true });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, control_concurrency: 5 });

    // 非法值报错且不落盘：文件保持上一次成功写入的内容。
    expect(() => settings.save({ concurrency: 0 })).toThrow('concurrency');
    expect(() => settings.save({ concurrency: 65 })).toThrow('concurrency');
    expect(() => settings.save({ control_concurrency: 17 })).toThrow('control_concurrency');
    expect(() => settings.save({ concurrency: 2.5 })).toThrow('integer');
    expect(() => settings.save({ nope: 1 })).toThrow('unknown field');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, control_concurrency: 5 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('corrupt or unsafe runtime settings fail loudly with the file path', () => {
  const root = temp();
  const config = new Config({ project: root, env: env() });
  config.prepare();
  try {
    const file = path.join(root, '.lush', 'settings.json');
    fs.writeFileSync(file, '{"version":1,"concurrency":0}\n', { mode: 0o600 });
    expect(() => new RuntimeSettings(config).get()).toThrow(file);
    fs.writeFileSync(file, '{not json', { mode: 0o600 });
    expect(() => new RuntimeSettings(config).get()).toThrow(file);
    fs.writeFileSync(file, JSON.stringify({ version: 2, concurrency: 4 }), { mode: 0o600 });
    expect(() => new RuntimeSettings(config).get()).toThrow('version 1');
    // 全局可读的宽权限被拒绝。
    fs.writeFileSync(file, JSON.stringify({ version: 1, concurrency: 4 }));
    fs.chmodSync(file, 0o644);
    expect(() => new RuntimeSettings(config).get()).toThrow('chmod 600');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('stored settings win over env defaults, and invalid env still fails at startup', () => {
  const root = temp();
  try {
    fs.mkdirSync(path.join(root, '.lush'), { recursive: true });
    fs.writeFileSync(path.join(root, '.lush', 'settings.json'), JSON.stringify({ version: 1, concurrency: 9, control_concurrency: 1 }), { mode: 0o600 });
    const config = new Config({ project: root, env: env({ LUSH_CONCURRENCY: '5', LUSH_CONTROL_CONCURRENCY: '3' }) });
    expect(config.concurrency).toBe(9);
    expect(config.controlConcurrency).toBe(1);
    expect(config.concurrencyDefault).toBe(5);
    expect(config.controlConcurrencyDefault).toBe(3);
    // 环境变量仍是启动时的硬校验：非整数直接抛错。
    expect(() => new Config({ project: root, env: env({ LUSH_CONCURRENCY: '2x' }) })).toThrow('integer');
    expect(() => new Config({ project: root, env: env({ LUSH_CONTROL_CONCURRENCY: '0' }) })).toThrow('integer');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('raising the limit admits queued work immediately; lowering it cancels nothing', async () => {
  const provider = controlled();
  const f = fixture(provider, { LUSH_CONCURRENCY: '1' });
  await repo(f.root);
  try {
    const first = f.store.create({ input_id: null, role: 'coordinator', goal: 'first' });
    const second = f.store.create({ input_id: null, role: 'coordinator', goal: 'second' });
    f.project.kick();
    await until(() => f.project.running.size === 1);
    expect(f.project.running.has(first.id)).toBe(true);
    expect(f.project.status().settings.concurrency).toEqual({ value: 1, default: 1, overridden: false });

    // 通过项目级写入口调高：内存生效值、status 镜像与调度准入都必须立刻跟上。
    const model = f.project.configureRuntimeSettings({ concurrency: 2 });
    expect(model.concurrency).toEqual({ value: 2, default: 1, overridden: true });
    expect(f.config.concurrency).toBe(2);
    expect(f.project.status()).toMatchObject({ concurrency: 2, control_concurrency: 2,
      settings: { concurrency: { value: 2, default: 1, overridden: true } } });
    await until(() => f.project.running.size === 2);
    expect(f.project.running.has(second.id)).toBe(true);

    // 调低到低于在跑数量：不取消任何在跑任务，只是不再准入新的。
    f.project.configureRuntimeSettings({ control_concurrency: 9 });
    expect(() => f.project.configureRuntimeSettings({ control_concurrency: 99 })).toThrow('control_concurrency');
    f.project.configureRuntimeSettings({ concurrency: 1 });
    expect(f.project.running.size).toBe(2);
    expect(f.project.status()).toMatchObject({ concurrency: 1, control_concurrency: 9 });
    expect(fs.existsSync(path.join(f.config.home, 'settings.json'))).toBe(true);

    for (const call of provider.calls) call.done.resolve('done');
    await until(() => f.project.running.size === 0);
    // 重新打开配置也读到持久化的生效值。
    expect(new Config({ project: f.root, env: env({ LUSH_CONCURRENCY: '1' }) })).toMatchObject({ concurrency: 1, controlConcurrency: 9 });
  } finally { await f.close(); }
});

test('system.configure is user-only and only accepts a settings patch', () => {
  // agent（actor 是任务 id）不得调用写接口；用户（actor null）可以。
  expect(() => assertAllowed('system.configure', { settings: { concurrency: 3 } }, 7)).toThrow('user approval');
  expect(assertAllowed('system.configure', { settings: { concurrency: 3 } }, null)).toBe(null);
  expect(() => assertAllowed('system.configure', { concurrency: 3 }, null)).toThrow('unknown parameter');
});
