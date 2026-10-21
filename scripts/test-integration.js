import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// Representative retained main flows only; not a second copy of the full suite.
// Keep selection here, not in docs or a second runner.
export const INTEGRATION_GROUPS = Object.freeze({
  page: Object.freeze([
    'test/web/assets.test.js', // startup graph and unchanged cold-loading budgets
    'test/web/dom-built-loading-assets.test.js', // compiled root and project boot
    'test/web/dom-administrator-page.test.js', // project Valet password elevation, ordinary fallback, unknown receipts and emergency stop
    'test/web/dom-detail.test.js', // Worker detail -> independent reader
    'test/web/dom-inputs-api.test.js', // composer -> HTTP/RPC -> draft and append
    'test/web/force-acceptance-page.test.js', // acceptance/reclamation -> pinned append editor cannot reopen
    'test/web/dom-valet-append-api.test.js', // Valet detail -> shared composer -> same-identity fresh round
    'test/web/dom-worker-create-api.test.js', // create/fork -> first Input receipt
    'test/web/dom-worker-cli-api.test.js', // CLI keyboard -> preview -> real CLI and history
    'test/web/valet-settings-page-integration.test.js', // same CLI schemas -> learning and live permissions
    'test/web/project-automation-ui-integration.test.js', // actual automation DOM -> HTTP/RPC mounts, usage and lifecycle
    'test/web/dom-valet-emergency-api.test.js', // user confirmation -> only occupied Valets -> isolation and fresh input
    'test/web/skills-page-integration.test.js', // Host settings -> next invocation prompt
  ]),
  rpc: Object.freeze([
    'test/worker-context.test.js', // invocation -> fixed CLI -> authorized RPC effects
    'test/project/management-cli.test.js', // Provider -> bridge -> CLI policy, execution and audit
    'test/project/administrator-execution.test.js', // native elevated occurrence -> isolated Provider/bridge -> current-project handler
    'test/administrator-runtime.test.js', // proof intake, per-occurrence authority, ordinary fallback and real-owner/unknown stop
    'test/project/merge-conditions-bridge.test.js', // real new merge syntax -> fixed parent queue
    'test/project/input-emission-protocol.test.js', // Dispatcher -> runtime -> Input/Message
    'test/project/merge-queue.test.js', // child delivery -> parent Squash -> acceptance
    'test/web/code-reader-api.test.js', // HTTP -> RPC -> Git tree/content/diff
    'test/web/automation-registry-api.test.js', // HTTP -> permanent/temporary definitions, pinned mounts and safe reclamation
  ]),
  component: Object.freeze([
    'test/web/dom-navigation.test.js', // list -> detail -> back
    'test/web/version-lineage.test.js', // compact lineage -> selected child endpoints -> same-snapshot page navigation
    'test/web/dom-inputs-api.test.js', // persisted draft editing and submission
    'test/web/dom-transcript-view.test.js', // single-button order, mixed/bulk fold and live tool results
    'test/web/dom-task-graph-integration.test.js', // compact node caret -> fold/reopen, both graph modes and delivery status
    'test/web/reading-conversation-integration.test.js', // shared reading controls -> real HTTP history/record pagination
    'test/web/transcript-reader.test.js', // shared search and explicit full-record reads
    'test/web/dom-questionnaire.test.js', // choices -> review -> answer
    'test/web/settings.test.js', // device preferences
  ]),
  cli: Object.freeze([
    'test/cli-entrypoints.test.js', // published bins and offline help
    'test/cli-catalog.test.js', // CommandSpec/help/parser projection and removed spellings
    'test/project/worker-create-bridge.test.js', // retired create rejects -> user RPC -> CLI first Input
    'test/project/worker-child-create.test.js', // compatible user copy RPC -> CLI reliable append/checkpoint
    'test/project/force-acceptance.test.js', // retired force rejects -> compatible user RPC preflight/confirmation
    'test/notice-cli.test.js', // offline question construction and validation
    'test/integration/questionnaire.test.js', // created question -> real CLI -> park and answer
    'test/integration/result-notice.test.js', // default info -> real CLI -> no parking
    'test/agent/capabilities.test.js', // shipped Skills and invocation prompt
    'test/worker-cli-trial.test.js', // HTTP -> real lush/lushw -> query and confirmed write
    'test/project/management-cli.test.js', // model CLI permissions and actual effects
    'test/integration/pi.test.js', // daemon -> controlled Provider -> CLI delegation
  ]),
});

const TYPES = Object.keys(INTEGRATION_GROUPS);
const USAGE = `Usage: bun run test:integration [--list] ${TYPES.join('|')} [type ...]
  --list  Print JSON selection/command without running tests (no types lists all).
  --help  Show this help.
Runs retained main-flow smoke tests through bun run test; does not replace the final full suite.`;

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
