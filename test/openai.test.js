import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { OpenAICompatibleProvider } from '../src/agent/openai.js';
import { LushError } from '../src/core/types.js';
import { cleanup, expectRejection, permissiveRoot, system, tmpdir } from './helpers.js';

describe('openai-compatible provider', () => {
  let dir;
  let db;
  let manager;
  let runtime;
  let http;
  let provider;
  let requests;
  let mode;

  beforeEach(() => {
    requests = [];
    mode = 'tools';
    http = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (req) => {
        const payload = await req.json();
        requests.push({ path: new URL(req.url).pathname, auth: req.headers.get('authorization'), payload });
        if (mode === 'error') return new Response('secret-error-body', { status: 401 });
        if (mode === 'malformed') return Response.json({ choices: [] });
        const last = payload.messages[payload.messages.length - 1];
        const body = last.role === 'tool'
          ? { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'created by HTTP provider' } }] }
          : {
            choices: [{
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: 'http-tool-1',
                  type: 'function',
                  function: {
                    name: 'process_spawn',
                    arguments: JSON.stringify({ template: 'research-task', name: 'research-http', goal: 'OAuth' }),
                  },
                }],
              },
            }],
          };
        return Response.json(body);
      },
    });
    provider = new OpenAICompatibleProvider('test-key', `http://127.0.0.1:${http.port}/v1`, 'test-model');
    dir = tmpdir('lush-http-');
    ({ database: db, manager, runtime } = system(dir, provider));
    permissiveRoot(manager);
  });

  afterEach(async () => {
    await runtime.shutdown();
    db.close();
    cleanup(dir);
    http.stop(true);
  });

  test('http multi-round tool protocol', async () => {
    const result = await manager.call(0, 'create a research task');
    expect(result.output).toBe('created by HTTP provider');
    expect(manager.children(0)[0].name).toBe('research-http');
    expect(requests.length).toBe(2);

    const [first, second] = requests;
    expect(first.path).toBe('/v1/chat/completions');
    expect(first.auth).toBe('Bearer test-key');
    expect(first.payload.model).toBe('test-model');
    expect(first.payload.tools.length).toBeGreaterThan(0);
    expect(first.payload.tools.every((tool) => !tool.function.name.includes('.'))).toBe(true);
    const messages = second.payload.messages;
    expect(messages[messages.length - 1].role).toBe('tool');
    expect(messages[messages.length - 1].tool_call_id).toBe('http-tool-1');
    expect(manager.history(0).messages.length).toBe(4);
  });

  test('http errors expose neither credentials nor bodies', async () => {
    mode = 'error';
    const error = await expectRejection(manager.call(0, 'fail'), /401/);
    expect(error.message).not.toContain('secret-error-body');
    expect(JSON.stringify(manager.inspect(0))).not.toContain('test-key');
    expect(requests.length).toBe(1); // no implicit retry
  });

  test('malformed response', async () => {
    mode = 'malformed';
    await expectRejection(manager.call(0, 'bad'), /invalid OpenAI-compatible response/);
  });

  test('configuration validation', () => {
    for (const [key, url, model] of [
      ['', 'http://localhost/v1', 'model'],
      ['key', 'file:///tmp/a', 'model'],
      ['key', 'http://localhost/v1', ''],
    ]) {
      expect(() => new OpenAICompatibleProvider(key, url, model)).toThrow(LushError);
    }
  });
});
