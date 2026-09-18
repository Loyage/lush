import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentCatalog } from '../src/agent/catalog.js';
import { MockAgentProvider } from '../src/agent/mock.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import { ContextBuilder } from '../src/context/builder.js';
import { LUSH_CONTEXT_PREFIX } from '../src/context/context.js';
import { ProcessManager } from '../src/core/process_manager.js';
import { Database } from '../src/persistence/database.js';
import { Repository } from '../src/persistence/repository.js';
import { TemplateLoader } from '../src/template_loader.js';

export function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanup(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

/** Composition root used by the tests: persistence + core + runtime, no socket. */
export function system(directory, provider = null, runtimeOptions = {}, orphanPolicy = undefined) {
  const {
    templates = new TemplateLoader(),
    catalog = new AgentCatalog({ home: directory, env: process.env }),
    ...options
  } = runtimeOptions;
  const database = new Database(path.join(directory, 'lush.db'));
  const repository = new Repository(database);
  const manager = new ProcessManager(repository, templates, orphanPolicy);
  manager.agentCatalog = catalog;
  manager.ensureRoot();
  repository.recover();
  const agent = provider ?? new MockAgentProvider();
  const runtime = new AgentRuntime(manager, agent,
    new ContextBuilder(repository, templates, { agentMode: agent.contextMode ?? 'tools' }), options);
  manager.runtime = runtime;
  return { database, manager, runtime };
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

export function contextPid(messages) {
  const payload = messages.find((message) => message.role === 'system' && message.content.startsWith(LUSH_CONTEXT_PREFIX));
  return JSON.parse(payload.content.slice(LUSH_CONTEXT_PREFIX.length)).process.pid;
}
