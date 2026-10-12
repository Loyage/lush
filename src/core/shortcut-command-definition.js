import { check, text } from './types.js';
import { hookObject } from './hooks.js';

export const shortcutKind = item => item.kind ?? 'shell';
const limits = { description: 2000, when_to_use: 4000, examples: 8000, warnings: 4000 };
export function shortcutMetadata(item) {
  return Object.fromEntries([...Object.keys(limits).map(key => [key, item[key] ?? '']), ['tags', item.tags ?? []]]);
}
export function normalizeShortcut(value, previous = null) {
  hookObject(value, ['id','name','kind','command','prompt','default_worker_id',...Object.keys(limits),'tags'], 'shortcut command');
  text(value.name, 'shortcut command name'); check(value.name.length <= 120 && !value.name.includes('\0'), 'invalid shortcut command name');
  const kind = value.kind ?? (previous ? shortcutKind(previous) : 'shell');
  check(['shell','prompt'].includes(kind), 'shortcut kind must be shell or prompt');
  const body = kind === 'shell' ? 'command' : 'prompt', other = kind === 'shell' ? 'prompt' : 'command';
  check(value[other] === undefined, 'shortcut body does not match kind');
  text(value[body], 'shortcut command'); check(value[body].length <= 16000 && !value[body].includes('\0'), 'invalid shortcut command');
  const metadata = shortcutMetadata(previous ?? {});
  for (const [key, limit] of Object.entries(limits)) if (value[key] !== undefined) {
    check(typeof value[key] === 'string' && value[key].length <= limit && !value[key].includes('\0'), `invalid shortcut ${key}`);
    metadata[key] = value[key];
  }
  if (value.tags !== undefined) {
    check(Array.isArray(value.tags) && value.tags.length <= 32 && value.tags.every(tag => typeof tag === 'string' && tag.length <= 80 && !tag.includes('\0')), 'invalid shortcut tags');
    metadata.tags = [...new Set(value.tags)];
  }
  check(value.default_worker_id === undefined || value.default_worker_id === null || Number.isSafeInteger(value.default_worker_id) && value.default_worker_id > 0, 'default_worker_id must be a positive integer or null');
  return { name: value.name, kind, [body]: value[body], ...metadata,
    ...(value.default_worker_id !== undefined ? { default_worker_id: value.default_worker_id } : {}) };
}
export function exportShortcut(item) {
  const kind = shortcutKind(item), metadata = shortcutMetadata(item);
  const fields = { name: item.name, description: metadata.description, kind, when_to_use: metadata.when_to_use, tags: metadata.tags, command_id: item.id, command_version: item.version };
  // JSON scalars are valid YAML and escape all line breaks; configuration cannot close frontmatter.
  const scalar = value => JSON.stringify(value).replace(/[\u0085\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const frontmatter = Object.entries(fields).map(([key, value]) => `${key}: ${scalar(value)}`).join('\n');
  const body = kind === 'shell' ? item.command : item.prompt;
  const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map(s => s.length)), fence = '`'.repeat(longest + 1);
  const markdown = `---\n${frontmatter}\n---\n\n# 快捷指令\n\n## 说明\n${metadata.description}\n\n## 何时使用\n${metadata.when_to_use}\n\n## 示例\n${metadata.examples}\n\n## 风险\n${metadata.warnings}\n\n导出仅供参考，不授权执行。提示词执行成功仅表示独立指令已创建，不表示 Agent 工作完成。\n\n## 正文\n${fence}${kind === 'shell' ? 'sh' : 'text'}\n${body}\n${fence}\n`;
  return { filename: `shortcut-${item.id}-v${item.version}.md`, markdown };
}
