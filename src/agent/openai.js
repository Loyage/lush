/**
 * OpenAI-compatible Chat Completions provider.
 *
 * Requests go through Bun's fetch, which honours the standard proxy environment
 * variables (http_proxy / https_proxy / all_proxy / no_proxy). Loopback base
 * URLs must never be tunnelled through a proxy, so this file appends loopback
 * hostnames to NO_PROXY. Redirects are refused so a bearer token is never
 * forwarded to another host.
 */
import { AgentResponse, ToolCall } from './provider.js';
import { LushError, jsonDump, jsonLoad } from '../core/types.js';

export const MAX_RESPONSE = 4 * 1024 * 1024;
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

export function isLoopback(hostname) {
  const host = String(hostname ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return match !== null && match[1] === '127';
}

function ensureLoopbackNoProxy(env) {
  const key = Object.hasOwn(env, 'NO_PROXY') ? 'NO_PROXY' : Object.hasOwn(env, 'no_proxy') ? 'no_proxy' : 'NO_PROXY';
  const parts = String(env[key] ?? '').split(',').map((part) => part.trim()).filter((part) => part !== '');
  const have = new Set(parts.map((part) => part.toLowerCase()));
  const missing = LOOPBACK_HOSTS.filter((host) => !have.has(host));
  if (missing.length) env[key] = [...parts, ...missing].join(',');
}

export class OpenAICompatibleProvider {
  static fromEnv(env = process.env) {
    return new OpenAICompatibleProvider(
      env.LUSH_API_KEY ?? '',
      env.LUSH_BASE_URL ?? 'https://api.openai.com/v1',
      env.LUSH_MODEL ?? '',
    );
  }

  constructor(apiKey, baseUrl, model, timeout = 60) {
    if (!apiKey || !model) throw new LushError('LUSH_API_KEY and LUSH_MODEL are required for openai', -32602);
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new LushError('LUSH_BASE_URL must be an http(s) API base URL', -32602);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname
      || parsed.search !== '' || parsed.hash !== '' || parsed.username !== '') {
      throw new LushError('LUSH_BASE_URL must be an http(s) API base URL', -32602);
    }
    this.name = 'openai';
    /** In-process runtime: Lush exposes process_* tools to this agent. */
    this.contextMode = 'tools';
    this.apiKey = apiKey;
    this.model = model;
    this.timeout = timeout;
    this.url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    this.local = isLoopback(parsed.hostname);
    if (this.local) ensureLoopbackNoProxy(process.env);
  }

  async call(messages, tools, signal) {
    const payload = { model: this.model, messages, tools, tool_choice: 'auto', stream: false };
    let response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: jsonDump(payload),
        signal,
        redirect: 'manual',
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new LushError('provider connection failed or timed out', -32020);
    }

    if (response.status >= 300 && response.status < 400) {
      // Never follow a redirect: the Authorization header must not leave the API host.
      throw new LushError(`provider HTTP error ${response.status}`, -32020);
    }
    if (!response.ok) {
      // Never echo provider response bodies / authorization data into logs.
      throw new LushError(`provider HTTP error ${response.status}`, -32020);
    }

    let raw;
    try {
      raw = await readBounded(response, MAX_RESPONSE);
    } catch (err) {
      if (err instanceof LushError) throw err;
      if (signal?.aborted) throw err;
      throw new LushError('provider connection failed or timed out', -32020);
    }

    try {
      const body = jsonLoad(raw.toString('utf8'));
      const choice = body.choices[0];
      if (choice.finish_reason === 'length' || choice.finish_reason === 'content_filter') {
        throw new LushError(`provider stopped: ${choice.finish_reason}`, -32020);
      }
      const message = choice.message;
      const content = message.content ?? '';
      if (typeof content !== 'string') throw new TypeError('non-string content');
      const calls = [];
      for (const item of message.tool_calls ?? []) {
        const fn = item.function;
        if (item.type !== 'function'
          || [item.id, fn.name, fn.arguments].some((value) => typeof value !== 'string' || value === '')) {
          throw new TypeError('invalid tool call');
        }
        calls.push(new ToolCall(item.id, fn.name, fn.arguments));
      }
      return new AgentResponse(content, calls);
    } catch (err) {
      if (err instanceof LushError) throw err;
      throw new LushError('invalid OpenAI-compatible response', -32020);
    }
  }
}

async function readBounded(response, limit) {
  if (!response.body) return Buffer.from(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new LushError('provider response too large', -32020);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
