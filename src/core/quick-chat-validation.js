import { check, id, isPlainObject } from './types.js';
import references from './project/references.js';

/** Closed request shapes: never accept paths, credentials, tokens or arbitrary RPC parameters. */
export function chatFields(value, allowed, required = []) {
  check(isPlainObject(value) && Object.keys(value).every(key => allowed.includes(key))
    && required.every(key => Object.hasOwn(value, key)), '快速对话请求字段无效');
}
export function chatId(value) { check(typeof value === 'number', '对话 ID 必须是整数'); return id(value); }
export function promptId(value) {
  check(typeof value === 'string' && (value === 'explain' || /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)), 'Prompt ID 无效');
  return value;
}
export function normalizeChatPrompt(value, builtin = false) {
  chatFields(value, ['id', 'name', 'prompt', 'context_menu', ...(builtin ? ['builtin'] : [])], ['name', 'prompt', 'context_menu']);
  if (value.id !== undefined) promptId(value.id);
  check(typeof value.name === 'string' && value.name.trim().length > 0 && value.name.length <= 80
    && !/[\r\n\x00-\x1f\x7f]/.test(value.name), 'Prompt 名称必须是 1–80 字的单行文字');
  check(typeof value.prompt === 'string' && value.prompt.trim().length > 0 && value.prompt.length <= 16384, 'Prompt 正文必须是 1–16384 字');
  check(typeof value.context_menu === 'boolean', '右键注册开关必须是布尔值');
  if (builtin) check(value.builtin === (value.id === 'explain'), '内置 Prompt 标记无效');
  return { ...(value.id === undefined ? {} : { id: value.id }), name: value.name.trim(), prompt: value.prompt.trim(), context_menu: value.context_menu,
    ...(builtin ? { builtin: value.id === 'explain' } : {}) };
}
export function chatContent(value, allowEmpty = false) {
  check(typeof value === 'string' && value.length <= 8192 && (allowEmpty || value.trim()), '请输入 1–8192 字的对话文字');
  return value.trim();
}
export function normalizeChatReferences(value = []) {
  check(Array.isArray(value) && value.length <= 12, '对话最多引用 12 项');
  check(Buffer.byteLength(JSON.stringify(value)) <= 48 * 1024, '引用快照合计不能超过 48 KiB');
  const snapshots = value.map(raw => {
    chatFields(raw, ['version', 'kind', 'target', 'label', 'quote', 'location', 'captured_at', 'project_id']);
    const { project_id, ...snapshot } = raw;
    check(project_id === undefined || typeof project_id === 'string' && /^[a-f0-9]{16}$/.test(project_id), '引用项目身份无效');
    // This is only the existing pure snapshot normalizer, NEVER its project/file resolver.
    const result = references.normalizeReferences([snapshot])[0];
    return { ...result, ...(project_id === undefined ? {} : { project_id }) };
  });
  check(Buffer.byteLength(JSON.stringify(snapshots)) <= 48 * 1024, '引用快照合计不能超过 48 KiB');
  return snapshots;
}
