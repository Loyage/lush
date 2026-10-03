import { test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { EVENTS, eventLabel } from '../../src/ui/web/assets/format.js';

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    return entry.isDirectory() ? sources(path) : entry.name.endsWith('.js') ? [readFileSync(path, 'utf8')] : [];
  });
}

test('所有源码中直接写入的事件类型都有中文名称，避免新事件退回纯代码标题', () => {
  const types = new Set();
  for (const directory of ['../../src/core/', '../../src/persistence/']) {
    for (const source of sources(new URL(directory, import.meta.url))) {
      // 仅提取 event 调用的字符串类型参数；动态状态事件在下方显式覆盖。
      for (const match of source.matchAll(/\.event\([^,\n]+,\s*(['"])([^'"]+)\1/g)) types.add(match[2]);
    }
  }
  expect(types.size).toBeGreaterThan(100);
  for (const type of types) {
    expect(Object.hasOwn(EVENTS, type)).toBe(true);
    expect(eventLabel({ type })).toMatch(/[\u4e00-\u9fff]/);
  }
});

test('动态结算与批量合并状态事件也有中文名称', () => {
  for (const type of ['completed', 'failed', 'cancelled', ...['merge.run', 'merge.orchestrate'].flatMap(prefix =>
    ['started', 'paused', 'completed', 'failed', 'cancelled'].map(status => `${prefix}.${status}`))]) {
    expect(Object.hasOwn(EVENTS, type)).toBe(true);
    expect(eventLabel({ type })).toMatch(/[\u4e00-\u9fff]/);
  }
});

test('提醒与待决问题的名称不同；未知类型不猜测语义、不读取原型属性', () => {
  expect(eventLabel({ type: 'task.reserved' })).toBe('已预约合并');
  expect(eventLabel({ type: 'notice.opened', data: { kind: 'info' } })).toBe('提醒');
  expect(eventLabel({ type: 'notice.opened', data: { kind: 'question' } })).toBe('向你提问');
  for (const type of ['future.event', 'constructor', 'toString', '__proto__']) {
    expect(eventLabel({ type })).toBe('未识别事件');
  }
});
