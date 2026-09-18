import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentCatalog } from '../src/agent/catalog.js';
import { MockAgentProvider } from '../src/agent/mock.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import { ContextBuilder } from '../src/context/builder.js';
import { LUSH_CONTEXT_PREFIX } from '../src/context/context.js';
import { ServiceManager } from '../src/core/service_manager.js';
import { Database } from '../src/persistence/database.js';
import { Repository } from '../src/persistence/repository.js';
import { TemplateLoader } from '../src/template_loader.js';

/**
 * The mock agent, slowed down: lets a test observe "the parent answered before
 * its child task was done" (which is what parks the parent in `waiting`).
 */
export class SlowProvider {
  /** `delay` is milliseconds, or `(invocation) => milliseconds` for a per-service one. */
  constructor(delay = 25) {
    this.name = 'mock';
    this.contextMode = 'tools';
    this.delay = delay;
    this.inner = new MockAgentProvider();
  }

  async call(messages, tools, signal, invocation) {
    await Bun.sleep(typeof this.delay === 'function' ? this.delay(invocation) : this.delay);
    return this.inner.call(messages, tools, signal, invocation);
  }
}

export function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanup(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

/** Composition root used by the tests: persistence + core + runtime, no socket. */
function registerTestTemplates(loader) {
  const base = {
    singleton: false,
    description: 'test-only generic service fixture',
    construct_prompt: 'test fixture service_construct',
    system_prompt: 'test fixture',
    child_templates: ['*'],
    variables: {},
  };
  for (const name of ['generic-task', 'generic-service', 'research-task']) {
    loader.register({ ...base, name });
  }
  return loader;
}

/**
 * Unit tests use generic service kinds as neutral fixtures. They are not
 * shipped templates anymore, so keep them explicit and test-only rather than
 * weakening the production template tree.
 */
export function testTemplates() {
  return registerTestTemplates(new TemplateLoader());
}

export function system(directory, provider = null, runtimeOptions = {}, orphanPolicy = undefined) {
  const {
    templates = testTemplates(),
    catalog = new AgentCatalog({ home: directory, env: process.env }),
    ...options
  } = runtimeOptions;
  const database = new Database(path.join(directory, 'lush.db'));
  const repository = new Repository(database);
  const manager = new ServiceManager(repository, templates, orphanPolicy);
  manager.agentCatalog = catalog;
  manager.ensureRoot();
  repository.recover();
  const agent = provider ?? new MockAgentProvider();
  const runtime = new AgentRuntime(manager, agent,
    new ContextBuilder(repository, templates, { agentMode: agent.contextMode ?? 'tools' }), options);
  manager.runtime = runtime;
  return { database, manager, runtime };
}

/**
 * SID 0's production template only allows project-manager. Most tests need a
 * parent that may construct any template, so they widen the *test* root explicitly;
 * the real whitelist is covered by dedicated tests in core.test.js.
 */
export function permissiveRoot(manager) {
  const snapshot = { ...manager.repository.get(0).template_snapshot, child_templates: ['*'] };
  manager.repository.replaceSnapshot(0, snapshot);
  return manager.load(0);
}

/** Await a promise that is expected to reject; returns the error for inspection. */
export async function expectRejection(promise, pattern = null) {
  let value;
  try {
    value = await promise;
  } catch (err) {
    if (pattern && !pattern.test(err.message)) {
      throw new Error(`unexpected rejection message: ${err.message}`);
    }
    return err;
  }
  throw new Error(`expected rejection, resolved with ${JSON.stringify(value)}`);
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** FIFO queue whose `next()` can be awaited. */
export function queue() {
  const items = [];
  const waiters = [];
  return {
    push(value) {
      const waiter = waiters.shift();
      if (waiter) waiter(value);
      else items.push(value);
    },
    async next() {
      if (items.length) return items.shift();
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

export function contextSid(messages) {
  const payload = messages.find((message) => message.role === 'system' && message.content.startsWith(LUSH_CONTEXT_PREFIX));
  return JSON.parse(payload.content.slice(LUSH_CONTEXT_PREFIX.length)).service.sid;
}

/** The task an invocation is working on, as the provider sees it. */
export function contextTaskId(messages) {
  const payload = messages.find((message) => message.role === 'system' && message.content.startsWith(LUSH_CONTEXT_PREFIX));
  return JSON.parse(payload.content.slice(LUSH_CONTEXT_PREFIX.length)).task?.id ?? null;
}
