import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// Representative retained main flows only; not a second copy of the full suite.
// Keep selection here, not in docs or a second runner.
export const INTEGRATION_GROUPS = Object.freeze({
  page: Object.freeze([
    'test/web/assets.test.js', // startup graph and existing cold-loading budgets
    'test/web/dom-built-loading-assets.test.js', // compiled app boots with shared state
    'test/web/dom-loading-assets.test.js', // lazy page boot
    'test/web/dom-detail.test.js', // Worker detail -> independent reader, without a Worker-return action
    'test/web/dom-worker-cli-api.test.js', // detail -> authenticated user preview/confirmation -> real CLI -> result and lifecycle
    'test/web/reading-conversation-integration.test.js', // input/output -> HTTP segmented raw copy
    'test/web/dom-navigation-links.test.js', // independent reader links
    'test/web/dom-inputs-api.test.js', // real UI -> HTTP/RPC/SQLite/Git input flow
    'test/web/valet-settings-page-integration.test.js', // global settings -> Host policy
    'test/web/dom-valet-append-api.test.js', // settled Valet detail -> authenticated HTTP/RPC -> fresh serial occurrence; busy rejection retains input
    'test/web/force-acceptance-page.test.js', // shared control -> authenticated HTTP -> exact terminal-receipt confirmation/reclamation
    'test/web/project-automation-ui-integration.test.js', // registry DOM -> real HTTP/RPC -> separate register/mount -> explicit version upgrade
    'test/dashboard-host-settings.test.js', // dashboard shared quick-action selection -> real Host writer
    'test/dashboard-quick-action-buttons.test.js', // v7 button catalogue -> Host revisioned device configuration
    'test/dashboard-retired-shortcuts.test.js', // preserve old device files without reintroducing node targets
  ]),
  rpc: Object.freeze([
    'test/core-api.test.js', // shared RPC registry and handlers
    'test/web/core-api.test.js', // real HTTP routes
    'test/worker-cli-trial.test.js', // user HTTP -> fixed real CLI -> daemon; confirmation, worktree admission, limits and unknown effects
    'test/web/automation-registry-api.test.js', // authenticated HTTP -> register-only, explicit mount/upgrade and auth rejection
    'test/web/silent-maintenance.test.js', // authenticated HTTP/RPC -> maintenance -> Host silent-batch evidence
    'test/web/code-reader-api.test.js', // HTTP -> RPC -> Git state/tree/content/diff
    'test/web/input-history.test.js', // persisted input history API
    'test/web/agent-connections-api.test.js', // connection configuration API
    'test/execution-retired-api.test.js', // real CLI/RPC/Host/HTTP reject retired execution nodes
    'test/project/execution-retired.test.js', // local runtime, immutable legacy records and restart admission
    'test/project/retired-delivery-queue.test.js', // real freeze -> queue -> Git, retain unknown landing without replay
    'test/execution-retired-freeze.test.js', // retired intent releases local parents, unknown Git landing does not
    'test/project/automation-registry.test.js', // registered references, fixed versions and explicit legacy upgrade
    'test/project/automation-registry-bridge.test.js', // real Provider/bridge -> ordered register/mount under current permissions -> execution receipt
    'test/project/management-tool-chain.test.js', // Node/Bun Provider -> real tools/bridge/RPC, including user-authorized fresh Valet rounds
    'test/project/management-append.test.js', // settled Valet -> user RPC append, serial admission, failure protection and recovery
    'test/project/management-append-size.test.js', // full-size immutable Message bodies and missing-instruction fail-closed
    'test/project/management-query.test.js', // typed CLI/manager queries -> real bridge, scope separation and safe rejection
    'test/project/management-permissions.test.js', // device defaults -> mandatory user confirmation -> global CAS
    'test/project/management-failure.test.js', // fixed safe failures -> persisted Run/Valet diagnostics
    'test/project/force-acceptance.test.js', // real CLI/RPC, user-only exact scope and unchanged acceptance safety/recovery
    'test/project/merge-queue.test.js', // local child -> parent -> main Squash and acceptance
  ]),
  component: Object.freeze([
    'test/web/dom-navigation.test.js', // navigation main flow
    'test/web/dom-detail-layout-preferences.test.js', // confirmed detail hierarchy
    'test/web/dom-worker-cli.test.js', // collapsed CLI editor, confirmation, plain results and request disposal
    'test/web/dom-conversation-copy.test.js', // exact raw/code copies, cancellation and clipboard fallback
    'test/web/dom-worker-timeline.test.js', // input/output compact controls, search disclosure and retained category/order state
    'test/web/dom-management-failure.test.js', // visible Valet diagnostics and no replay
    'test/web/dom-valet-append.test.js', // Agent-marked append form, retained text, single-flight and late-response isolation
    'test/web/dom-inputs.test.js', // draft editor
    'test/web/dom-transcript-sidebar.test.js', // reader step navigation
    'test/web/dom-transcript-view.test.js', // bulk folding across paging and live steps
    'test/web/dom-model-sources.test.js', // model settings main flow
    'test/web/dom-questionnaire.test.js', // questionnaire interaction
    'test/web/dom-runners-page.test.js', // retired bookmarks, local forms and read-only legacy Worker actions
    'test/web/dom-project-automation.test.js', // automation page
    'test/web/settings.test.js', // settings entry
    'test/web/service-restart-controls.test.js', // quick/manual modes, shared single-flight and disposal
    'test/web/device-auto-select-action.test.js', // shared authorization lease, unknown-write gate, stale reads and pagehide
    'test/web/safe-restart-flow.test.js', // fixed scope, silent evidence and restart failure boundaries
  ]),
  cli: Object.freeze([
    'test/cli-surfaces.test.js', // executable catalogue
    'test/cli-catalog.test.js', // parser/catalogue agreement
    'test/cli-entrypoints.test.js', // published bins/source scripts -> real CLI/RPC and unchanged authority
    'test/agent/capabilities.test.js', // shipped Skills/guides and invocation prompt agree on the fixed development CLI
    'test/project/force-acceptance.test.js', // user CLI preview/confirm and authoritative refusal of unsafe scope
    'test/project/automation-registry-cli.test.js', // real user CLI -> register-only RPC -> fixed-reference mount
    'test/project/management-permissions.test.js', // real management permission CLI and Provider bridge
    'test/integration/pi.test.js', // daemon -> controlled Provider -> CLI delegation
    'test/integration/questionnaire.test.js', // notice CLI -> exit -> restart -> answer
    'test/integration/result-notice.test.js', // Skill snapshot -> pinned CLI -> own info -> unread inbox, without parking
    'test/execution-retired-api.test.js', // public CLI/Provider bridge cannot restore retired execution capabilities
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
