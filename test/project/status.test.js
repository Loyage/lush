import { test, expect } from 'bun:test';
import { fixture } from '../helpers.js';

/** system.status 的只读软件配置镜像：设置页「系统信息」组直接读这些字段，这里固定它们的口径。 */
const noop = { async run() { return 'noop'; } };

test('system.status mirrors read-only software config from daemon startup env', async () => {
  const f = fixture(noop, { LUSH_CALL_TIMEOUT: '600', LUSH_TASK_CALLS: '12', LUSH_MAX_DEPTH: '5' });
  try {
    expect(f.project.status()).toMatchObject({
      provider: 'mock', concurrency: 4, control_concurrency: 2,
      call_timeout: 600, task_call_limit: 12, max_depth: 5,
      // 未设置的 pi 覆写项是空字符串，由界面显示「pi 默认」，不编造默认模型 / provider 名。
      pi_model: '', pi_provider: '',
    });
    // settings 是运行设置的读写镜像：调用 / 拆解限额与并发一样给出生效值、环境默认与来源。
    expect(f.project.status().settings).toMatchObject({
      call_timeout: { value: 600, default: 600, overridden: false },
      task_call_limit: { value: 12, default: 12, overridden: false },
      max_depth: { value: 5, default: 5, overridden: false },
    });
  } finally { await f.close(); }
});

test('system.status uses config defaults when env is silent and reports pi overrides when set', async () => {
  const defaults = fixture(noop);
  try {
    expect(defaults.project.status()).toMatchObject({ call_timeout: 900, task_call_limit: 24, max_depth: 8 });
  } finally { await defaults.close(); }

  const set = fixture(noop, { LUSH_PI_MODEL: 'gpt-5', LUSH_PI_PROVIDER: 'openai' });
  try {
    expect(set.project.status()).toMatchObject({ pi_model: 'gpt-5', pi_provider: 'openai' });
  } finally { await set.close(); }
});
