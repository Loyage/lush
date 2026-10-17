import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// Existing regression files only. Keep selection here, not in docs or a second runner.
export const INTEGRATION_GROUPS = Object.freeze({
  page: Object.freeze([
    'test/web/dom-inputs-api.test.js', // real UI -> HTTP/RPC/SQLite/Git: sent history, deferred modes, actual delivery and receipt navigation
    'test/web/runner-choice-page-integration.test.js', // page -> real HTTP/RPC/draft -> independent Runner creation and no fallback
    'test/web/runner-settings-page-integration.test.js', // independent global page -> real Host/project policy, inert reads and explicit Runner check
    'test/web/dom-runners-page.test.js', // bookmarks, navigation migration, fixed project source, offline/late replies and retained editors
    'test/web/runner-detail-page-integration.test.js', // real HTTP/RPC location projection, unknown/revocation and inert reads
    'test/web/runner-verification-page-integration.test.js', // explicit page -> original receipt recovery, preserved dirty work, no model restart
    'test/web/dom-navigation.test.js', // navigation, Worker deep links, back state
    'test/web/dom-task-graph-clutter.test.js', // inline merge status beside usage, diagnostics and action placement
    'test/web/core-api.test.js', // rendered navigation allowlist and real HTTP action/read routes
    'test/web/dom-loading-assets.test.js', // lazy routes and root deep-link boot
    'test/web/performance-api.test.js', // performance tab -> real authenticated evidence -> ranking and original-step navigation
    'test/web/settings.test.js', // old device Runner entry navigates to the independent global page without project polling
    'test/web/cli-catalog-api.test.js', // actual Runner command names are public, credential payloads are not
    'test/web/cli-catalog-cache.test.js', // authenticated static Runner catalogue without project startup
    'test/web/dom-valet-settings.test.js', // unified CLI discovery, detail navigation and permission drafts
    'test/web/dom-valet-settings-navigation.test.js', // lazy CLI route, retained state and dirty leave guards
    'test/web/valet-settings-page-integration.test.js', // global CLI page -> Host device policy -> existing Valet and restricted Provider bridge
    'test/web/assets.test.js', // startup/lazy resource graphs and CSP
    'test/web/dom-built-loading-assets.test.js', // compiled root/project boot and shared state
    'test/web/loading-assets.test.js', // authenticated Host, cold JS/CSS budgets and compression
  ]),
  rpc: Object.freeze([
    'test/web/input-history.test.js', // registered view parameters, strict HTTP/RPC queries and unchanged user-only writes
    'test/web/input-read-models.test.js', // actual history/draft partition, conditional receipts, frozen inbox and management bridge
    'test/project/input-read-models.test.js', // whole-database pagination, unique source links and conservative user provenance
    'test/web/runner-deployment-api.test.js', // user HTTP -> real deployment service -> controlled SSH blocked; no install or fabricated production readiness
    'test/project/lifecycle-evidence.test.js', // controlled Provider -> durable phases/input provenance -> existing authenticated history APIs
    'test/web/worker-lifecycle-integration.test.js', // real Project/HTTP facts -> two independent readers and exact source navigation
    'test/web/performance-api.test.js', // authenticated project HTTP/RPC -> bounded timing evidence without results/configuration
    'test/project/runner-emission-chain.test.js', // actual user CLI -> persisted selection -> Project/leased Bridge -> independent Runner commit
    'test/project/runner-tool-reconcile.test.js', // lost Bridge ACK -> central restart -> actual user CLI/HTTP verification; no replay or automatic retry
    'test/project/runner-command-reconcile.test.js', // command admission ACK is not stop proof; original execution and unknown stop
    'test/project/runner-file-reconcile.test.js', // edit/history digests, Unicode paths and unowned dirty-content refusal
    'test/project/input-emissions-runner.test.js', // persisted placement, keyed conflicts, latest authorization and no replay after failure
    'test/project/input-emissions-remote-quiet.test.js', // real Runner cleanliness/removal -> conditional input/exclusive admission and publication guards
    'test/runner-placement-api.test.js', // creation arguments and actual CLI/RPC -> persisted input selection
    'test/runner-management-api.test.js', // actual user CLI/RPC -> central service -> independent Runner; strict user-only/secret boundaries
    'test/web/runner-management-api.test.js', // authenticated Project/Host API, inert reads and explicit paired diagnostic without project startup
    'test/runner-ssh.test.js', // safe config/Include budgets and real user CLI/RPC -> controlled SSH process, no Runner credentials
    'test/web/runner-ssh-api.test.js', // user Host/project HTTP -> shared registry -> controlled SSH; inert discovery, no project startup
    'test/core-api.test.js', // registry/handler parity and public namespace
    'test/worker-api.test.js', // strict spawn placement namespace and unchanged Agent authority
    'test/project/auto-merge.test.js', // local order/child automatic delivery representative paths
    'test/project/runner-merge-shutdown.test.js', // local late admission plus remote merge evidence cannot outlive Store
    'test/integration-rpc-permissions.test.js', // default-deny, actor binding and live authentication
    'test/web/worker-api.test.js', // HTTP forwarding, typed params, login/Origin and mutation allowlist
    'test/rpc-public-result.test.js', // Dispatcher public result projection
    'test/web/rpc-public-result.test.js', // HTTP result envelopes and authorized config
    'test/project/management-tool-chain.test.js', // controlled Provider/real tools/bridge/live RPC authorization
    'test/agent/remote-bridge.test.js', // remote tools and real collaboration Dispatcher, revocation/questionnaire stop barrier
    'test/workspaces/remote-bridge-integration.test.js', // Runner Bridge commit -> central receipt -> cross-node child -> guarded cleanup
    'test/project/runner-delivery.test.js', // registered user-only merge RPC -> Project queue -> remote parent ACK/restart and fixed source repair
    'test/project/runner-delivery-chain.test.js', // real recursive cross-node spawn/checkpoints -> parent ACK -> batch acceptance
    'test/project/runner-early-cancel-chain.test.js', // immediate real RPC cancel after command.start, before any READY wait
    'test/project/runner-hook-boundary.test.js', // remote bindings cannot execute Shell Hooks through an external local checkout
    'test/web/remote-code-reader-api.test.js', // authenticated user HTTP -> actual Runner sampling, no stale local fallback
    'test/project/runner-parent-sync.test.js', // sync RPC -> fixed candidate -> remote ACK -> Project settlement and recovery barriers
    'test/project/runner-connection-guards.test.js', // live connection configuration guards across delivery and reclamation
    'test/project/runner-lifecycle-reclamation.test.js', // Project delivery/cancel -> checked remote batch acceptance/cleanup/delete
    'test/project/runner-unprepared-deletion.test.js', // user RPC preview/confirmation -> original-node absence/fence -> checked history deletion
    'test/project/hook-install-chain.test.js', // install CLI/HTTP and real management bridge -> exact confirmation -> atomic config -> real merges
    'test/project/management-live-permissions.test.js', // existing Valet, queued/confirmed requests, write-admission races and persisted policy
    'test/project/management-code-provider-chain.test.js', // registered tools -> real Bun bridge -> device policy and exact confirmation
    'test/management-permissions-device.test.js', // first publication, private storage, revisions and shared authorization lock
    'test/web/management-permissions-host-api.test.js', // root Host policy without projects/daemons, authentication and strict fields
    'test/integration/management-permissions.test.js', // independent daemons share policy, retain project history and reject retired writes
    'test/web/management-permissions-api.test.js', // device policy persistence, historical receipts and confirmation
    'test/web/runtime-coordinator-integration.test.js', // HTTP/RPC -> durable intent -> coordinated checks -> Provider/bound RPC; freeze/cancel/edge preservation
  ]),
  component: Object.freeze([
    'test/web/dom-inputs.test.js', // separate history/drafts, conditional editor, dirty navigation, single-flight and late-result guards
    'test/web/dom-worker-lifecycle.test.js', // phase intervals, causal evidence, retained reader state and exact reference routing
    'test/web/worker-lifecycle-model.test.js', // honest legacy/gap/partial-history projection
    'test/transcript-shell.test.js', // complete Bash argument fingerprints, bounded previews and explicit result evidence
    'test/web/performance-data.test.js', // explicit full scan, bounded metadata, cancellation and strict pagination
    'test/web/performance-model.test.js', // interval unions, unknown/partial evidence, net milestones and unique tool pairing
    'test/web/dom-performance-view.test.js', // lazy tab, cancelled/late scans, ranked source navigation and retained samples
    'test/web/dom-detail-layout-preferences.test.js', // confirmed input-output / lifecycle module hierarchy
    'test/web/dom-detail-progressive.test.js', // cached history/loading state, selection deferral and lifecycle listener cleanup
    'test/web/dom-task-message.test.js', // communication/raw references now belong to the lifecycle reader
    'test/web/dom-studio.test.js', // content precedes lifecycle and implementation metadata
    'test/web/dom-input-buffer.test.js', // mode-specific Enter, button buffering, IME/touch and shared submission guards
    'test/web/dom-runner-choice.test.js', // More visibility, lazy reads, mode isolation, fixed selection, fingerprints and late edits
    'test/web/dom-runner-choice-reset.test.js', // D655 null only on draft.update, omitted old fields and ACK revision baseline
    'test/web/dom-runner-choice-legacy.test.js', // legacy draft ACK consumption, failed refresh and stale snapshot guards
    'test/web/dom-runner-settings.test.js', // revisions, secret disposal, explicit pin, fixed source and unknown-write/late response guards
    'test/web/dom-runner-ssh.test.js', // new-node discovery/manual choice, independent single-flight test and stale dialog/input guards
    'test/web/dom-runner-deploy-wizard.test.js', // frozen action previews/independent approvals and unknown guards; adapter UI only, not production acceptance
    'test/web/dom-runner-recovery-wizard.test.js', // original installation/generation/observation barriers; adapter UI only, not production recovery proof
    'test/web/dom-runner-detail.test.js', // fixed remote identity, visible barriers, local compatibility and expansion retention
    'test/web/dom-runner-verification.test.js', // revision-bound single flight, false ACK, late navigation and post-ACK read failure
    'test/web/settings-module-boundaries.test.js', // entry exports, acyclic imports and built graph
    'test/web/event-labels.test.js', // every new persistent Runner event has a truthful public label
    'test/web/dom-detail-requests.test.js', // leaving/boot cancellation and late-publication guards
    'test/web/dom-refresh-performance.test.js', // request counts, polling cadence, backoff and retained rows
    'test/web/dom-project-automation.test.js', // retained nodes and state on return
    'test/web/dom-shared-module.test.js', // compatibility wrappers and reading/fold restoration
    'test/web/dom-navigation.test.js', // integrated back navigation and retained input/selection
  ]),
  cli: Object.freeze([
    'test/project/runner-emission-chain.test.js', // explicit non-default node reaches real creation and received Git objects
    'test/project/runner-tool-reconcile.test.js', // user CLI exact binding revision reaches journal verification, never auto-starts a model
    'test/runner-placement-api.test.js', // placement parser and actual CLI/RPC persistence through reliable emission
    'test/runner-management-api.test.js', // management-only executable, private input and real Runner RPC chain
    'test/runner-deployment-api.test.js', // all nested deployment/recovery CLI verbs, owner-private files, registry/permissions and actual fail-closed SSH chain
    'test/runner-ssh.test.js', // real user CLI/RPC -> controlled SSH; discovery never executes config, typed user-only schema
    'test/cli-surfaces.test.js', // CLI capability set derives from the registered catalogue
    'test/cli-catalog.test.js', // public catalogue and actual parser/RPC dispatch agree
    'test/hook-install-api.test.js', // install parser/registry/schema/user-only gates and safe receipt
    'test/cli-entrypoints.test.js', // fixed binaries, migration refusals and source shortcuts -> live RPC
    'test/cli-prompt-boundaries.test.js', // active prompts/guides do not teach retired CLI aliases
    'test/integration/pi.test.js', // real daemon -> Provider -> pinned CLI -> delegation and prompt injection
    'test/integration/questionnaire.test.js', // pinned notice CLI, process exit, restart and answer recovery
    'test/agent/remote-bridge.test.js', // dedicated remote lushc tool -> actual CLI parser/Dispatcher and bounded questionnaire control file
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
