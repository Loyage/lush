import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, until } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { PARAMS, USER_ONLY, assertAllowed } from '../../src/rpc/registry.js';
import { normalizeBaseUrl } from '../../src/core/quick-intro.js';

test('快速介绍设置：遮蔽 API Key、原子落盘、校验并支持部分更新', () => {
  const f = fixture();
  try {
    expect(f.project.introConfig()).toMatchObject({ base_url: '', model: '', has_key: false, ready: false });
    const saved = f.project.configureIntro({ base_url: 'https://api.openai.com/v1/', model: ' gpt-4o-mini ', api_key: 'sk-abcdef1234' });
    expect(saved).toMatchObject({ base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', has_key: true, key_hint: '••••1234', ready: true });
    expect(saved.api_key).toBeUndefined();
    const file = path.join(f.config.home, 'quick-intro.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).api_key).toBe('sk-abcdef1234');
    // 未出现的键保持，null 清除；不配置 Key 也能 ready（本地服务）。
    expect(f.project.configureIntro({ model: 'gpt-4o' }).has_key).toBe(true);
    expect(f.project.configureIntro({ api_key: null }).has_key).toBe(false);
    expect(f.project.configureIntro({ base_url: null }).ready).toBe(false);
    // 非法值既不生效也不落盘。
    expect(() => f.project.configureIntro({ base_url: 'ftp://x' })).toThrow('http');
    expect(() => f.project.configureIntro({ nope: 1 })).toThrow('unknown field');
    expect(normalizeBaseUrl('https://api.x.com/v1/chat/completions')).toBe('https://api.x.com/v1');
  } finally { f.close(); }
});

test('快速介绍直连 OpenAI 兼容接口，写解释历史但不建任务', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '这是对所选文字的解释。' } }] }) }; };
  try {
    f.project.configureIntro({ base_url: 'https://api.example.com/v1', model: 'demo', api_key: 'sk-1' });
    const record = f.project.startIntro('一段引用文字', { view: 'task-detail', section: 'selection', task_id: 5 });
    expect(record.status).toBe('running');
    await until(() => f.store.intro(record.id).status === 'completed');
    // 不建任务、不建输入分支。
    expect(f.store.tasks()).toHaveLength(0);
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0);
    expect(calls[0].url).toBe('https://api.example.com/v1/chat/completions');
    expect(calls[0].options.headers.Authorization).toBe('Bearer sk-1');
    const body = JSON.parse(calls[0].options.body);
    expect(body.model).toBe('demo');
    expect(body.messages[0].content).toContain('只解释，不执行');
    expect(body.messages[1].content).toContain('一段引用文字');
    const saved = f.project.introduction(record.id);
    expect(saved.result).toContain('这是对所选文字的解释');
    expect(saved.location.task_id).toBe(5);
    const history = f.project.introductions(5);
    expect(history.introductions[0]).toMatchObject({ id: record.id, kind: 'quick', status: 'completed' });
    // 只归到来源任务，不串到别的任务。
    expect(f.project.introductions(6).introductions).toHaveLength(0);
    const rpc = new Dispatcher(f.project);
    expect((await rpc.dispatch('intro.list', { id: 5 })).introductions[0].id).toBe(record.id);
    expect((await rpc.dispatch('intro.get', { id: record.id })).quote).toBe('一段引用文字');
  } finally { globalThis.fetch = original; await f.close(); }
});

test('未配置或校验失败时不落记录', () => {
  const f = fixture();
  try {
    expect(() => f.project.startIntro('x', {})).toThrow('请先在设置里');
    f.project.configureIntro({ base_url: 'https://api.example.com/v1', model: 'demo' });
    expect(() => f.project.startIntro('', {})).toThrow('1–8192');
    expect(() => f.project.startIntro('x'.repeat(8193), {})).toThrow('1–8192');
    expect(() => f.project.startIntro('x', { unknown: 1 })).toThrow('unknown location field');
    expect(f.store.all('SELECT * FROM introductions')).toHaveLength(0);
  } finally { f.close(); }
});

test('模型接口报错时记录为 failed', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'bad key' });
  try {
    f.project.configureIntro({ base_url: 'https://api.example.com/v1', model: 'demo' });
    const record = f.project.startIntro('x', {});
    await until(() => f.store.intro(record.id).status === 'failed');
    expect(f.project.introduction(record.id).error).toContain('401');
  } finally { globalThis.fetch = original; await f.close(); }
});

test('重启恢复把遗留的 running 介绍落成 failed', () => {
  const f = fixture();
  try {
    const row = f.store.introCreate({ quote: 'x', location: {}, baseUrl: '', model: '' });
    expect(f.store.intro(row.id).status).toBe('running');
    f.project.recover();
    expect(f.store.intro(row.id).status).toBe('failed');
  } finally { f.close(); }
});

test('intro RPC 是用户专属且参数受限', () => {
  expect(PARAMS['intro.start']).toEqual(['quote', 'location']);
  expect(USER_ONLY.has('intro.start')).toBe(true);
  expect(assertAllowed('intro.start', { quote: 'x', location: {} }, null)).toBe(null);
  expect(() => assertAllowed('intro.start', { quote: 'x', location: {}, id: 1 }, null)).toThrow('unknown parameter');
  expect(() => assertAllowed('intro.configure', { config: {} }, 3)).toThrow('user approval');
});
