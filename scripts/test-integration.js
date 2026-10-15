import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// Existing regression files only. Keep selection here, not in docs or a second runner.
export const INTEGRATION_GROUPS = Object.freeze({
  page: Object.freeze([
    'test/web/dom-navigation.test.js', // navigation, Worker deep links, back state
    'test/web/core-api.test.js', // rendered navigation allowlist and real HTTP action/read routes
    'test/web/dom-loading-assets.test.js', // lazy routes and root deep-link boot
    'test/web/assets.test.js', // startup/lazy resource graphs and CSP
    'test/web/dom-built-loading-assets.test.js', // compiled root/project boot and shared state
    'test/web/loading-assets.test.js', // authenticated Host, cold JS/CSS budgets and compression
  ]),
  rpc: Object.freeze([
    'test/core-api.test.js', // registry/handler parity and public namespace
    'test/integration-rpc-permissions.test.js', // default-deny, actor binding and live authentication
    'test/web/worker-api.test.js', // HTTP forwarding, typed params, login/Origin and mutation allowlist
    'test/rpc-public-result.test.js', // Dispatcher public result projection
    'test/web/rpc-public-result.test.js', // HTTP result envelopes and authorized config
    'test/project/management-tool-chain.test.js', // controlled Provider/real tools/bridge/live RPC authorization
    'test/web/management-permissions-api.test.js', // actual permission defaults, frozen snapshots and confirmation
  ]),
  component: Object.freeze([
    'test/web/settings-module-boundaries.test.js', // entry exports, acyclic imports and built graph
    'test/web/dom-detail-requests.test.js', // leaving/boot cancellation and late-publication guards
    'test/web/dom-refresh-performance.test.js', // request counts, polling cadence, backoff and retained rows
    'test/web/dom-project-automation.test.js', // retained nodes and state on return
    'test/web/dom-shared-module.test.js', // compatibility wrappers and reading/fold restoration
    'test/web/dom-navigation.test.js', // integrated back navigation and retained input/selection
  ]),
  cli: Object.freeze([
    'test/cli-surfaces.test.js', // CLI capability set derives from the registered catalogue
    'test/cli-catalog.test.js', // public catalogue and actual parser/RPC dispatch agree
    'test/cli-entrypoints.test.js', // fixed binaries, migration refusals and source shortcuts -> live RPC
    'test/cli-prompt-boundaries.test.js', // active prompts/guides do not teach retired CLI aliases
    'test/integration/pi.test.js', // real daemon -> Provider -> pinned CLI -> delegation and prompt injection
    'test/integration/questionnaire.test.js', // pinned notice CLI, process exit, restart and answer recovery
  ]),
});

const TYPES = Object.keys(INTEGRATION_GROUPS);
const USAGE = `Usage: bun run test:integration [--list] ${TYPES.join('|')} [type ...]
  --list  Print JSON selection/command without running tests (no types lists all).
  --help  Show this help.
Runs the existing bun run test entrypoint once; does not replace the final full suite.`;

export function parseIntegrationArgs(args) {
  const types = [];
  let list = false;
  if (args.length === 1 && args[0] === '--help') return { help: true };
  for (const arg of args) {
    if (arg === '--list') { list = true; continue; }
    if (!Object.hasOwn(INTEGRATION_GROUPS, arg)) {
      throw new Error(`Unknown integration type or option: ${arg}. Expected ${TYPES.join(', ')} or --list/--help.`);
    }
    if (!types.includes(arg)) types.push(arg);
  }
  if (!types.length && !list) throw new Error(`Select at least one integration type: ${TYPES.join(', ')}.`);
  return { list, types: types.length ? types : [...TYPES] };
}

export function selectIntegrationFiles(types) {
  const files = new Set();
  for (const type of types) {
    if (!Object.hasOwn(INTEGRATION_GROUPS, type)) throw new Error(`Unknown integration type: ${type}.`);
    for (const file of INTEGRATION_GROUPS[type]) files.add(file);
  }
  return [...files];
}

// The injected root/spawn/output are only for mechanical script tests; no runtime policy.
export async function runIntegration(args, {
  root = ROOT, spawn = Bun.spawn,
  stdout = text => console.log(text), stderr = text => console.error(text),
} = {}) {
  try {
    const parsed = parseIntegrationArgs(args);
    if (parsed.help) { stdout(USAGE); return 0; }
    const files = selectIntegrationFiles(parsed.types);
    for (const file of files) {
      let stat;
      try { stat = fs.statSync(path.join(root, file)); }
      catch (error) { throw new Error(`Integration test path unavailable: ${file} (${error.code ?? error.message}).`); }
      if (!stat.isFile()) throw new Error(`Integration test path is not a file: ${file}.`);
    }
    const command = [process.execPath, 'run', 'test', ...files];
    if (parsed.list) {
      stdout(JSON.stringify({ types: parsed.types, files, command }, null, 2));
      return 0;
    }
    stderr(`Integration (${parsed.types.join(', ')}): bun run test ${files.join(' ')}`);
    const child = spawn(command, { cwd: root, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
    return await child.exited;
  } catch (error) {
    stderr(`test:integration: ${error.message}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runIntegration(process.argv.slice(2));
