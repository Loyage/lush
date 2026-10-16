# Remote workspace feasibility fixture

**Experimental verification only, not a production Runner protocol or enabled remote Worker.**

## Run / dependency boundary

```sh
LUSH_REMOTE_PI_FEASIBILITY=1 bun run test test/remote-workspaces-feasibility.test.js
```

Requires Linux, Bash, Git and an installed, importable Pi SDK (`pi` on PATH or
`LUSH_PI_COMMAND` pointing to its executable). Resolves through the existing
`resolveNativePi`, without installing anything. Explicit opt-in fails if the SDK
is absent/incompatible; without the flag the four real-SDK scenarios are visibly
skipped, while configuration-gate coverage runs normally. The standard 20-second
per-test budget is unchanged; fixture shutdown starts at 15 seconds. The tested
SDK was `@earendil-works/pi-coding-agent` **1.0.4**, Bun **1.4.2**.

No actual credentials or paid model calls. A loopback HTTP endpoint supplies
OpenAI-compatible SSE; Pi's real ModelRuntime, provider serialization, agent loop,
tool registry, validation, error handling, image processing and persisted sessions
run unchanged. Neither Pi APIs nor its tool-execution loop are mocked.

## Chain and reusable seams

- `registry.js`: `TOOL_REGISTRY`/`TOOL_NAMES` are the single tool source used for
  Pi registration, Bridge/Runner permissions, handshake and wire assertions.
  `assertSupportedConfiguration` refuses non-Lush Pi modes and explicitly requested
  unsupported resources before process admission. Fixture transport is stdio only;
  it deliberately does **not** accept an `ssh` configuration and pretend to test SSH.
- `createRemoteTools`: reuse Pi's parameter schemas/descriptions, replace all four
  execute functions; do not copy local execution closures or edit-preview renderers.
- `bridge.js`: `RunnerBridge` owns invocation binding and request correlation,
  forwards cancellation and waits for the remote result, and blocks new requests
  after connection loss. No local filesystem or shell fallback.
- `controlled-session.js`: `createControlledSession` creates a real SDK session
  with an explicit resource loader and custom tools. Optional `runtimeContext` loads
  the fixed production `src/agent/pi-runtime.js` factory through Pi's actual extension
  loader, then explicitly calls `session.bindExtensions()`. Optional `sessionFile`
  uses `SessionManager.open` for local restoration. It exposes only prompt, abort,
  subscription, diagnostics and close—not raw `executeBash`, arbitrary extensions,
  CLI RPC or resource-loading entry points.
- `runner.js`: separate process, separate Git repository and deliberately restricted
  environment. Uses actual Pi tools for file/image semantics; Bash operations are
  replaced with a process-group executor for this Linux fixture. Context discovery
  uses Pi's `loadProjectContextFiles`, filtered to the owned repository.
- `scenario.js`: isolated controller process plus model HTTP fixture; checks actual
  provider requests, final Pi messages, on-disk effects, authorization failures,
  sessions and process exit evidence. Every temporary repository/process is owned
  by this test; no project daemon, user repository or credential file is used.

Suggested production seams: `src/agent/provider.js` should select an explicitly
supported controlled bootstrap before launching; `pi-runtime.js`/prompt construction
should distinguish local control/session paths from Runner code paths and install
an exit barrier. A production Runner transport should replace `RunnerBridge`'s
stdio subprocess, not replace code commands with handwritten SSH strings. Runner
admission, durable identities/leases, Git objects and lifecycle integration belong
to the parent implementation; these exports are test seams, not frozen APIs.

## What is demonstrated

1. Real Provider → SDK registration/validation → bound permission Bridge → separate
   process → separate repository → result → next real Provider request.
2. `read`, precise multi-edit schema, `write`, `bash` and a valid PNG route to the
   Runner. The local repository contains different same-name files, a local-only
   fallback candidate and a deliberately invalid same-name image. No local content
   reaches the Provider and no local code is modified. Absolute control paths,
   `..` and symlink escape are denied by code-file tools.
3. Provider-declared tools, SDK active tools, Runner capabilities and registered
   permission names match. A model-issued unregistered `grep` call fails instead
   of reaching Pi's local built-in; wrong project/Worker/Run/generation/token frames
   fail on the actual Runner. Duplicate request IDs are rejected without replay.
4. Remote root AGENTS enters the initial model context. Scoped file results include
   Pi-discovered ancestor/nested instructions with `AGENTS.override.md` precedence;
   local AGENTS and poisoned local/remote `.pi` extensions, settings, packages,
   skills, MCP, system prompts and templates are never discovered. Sessions remain
   in the local control directory, whose files are not accessible through code tools.
5. A separate lifecycle scenario runs the unchanged trusted `pi-runtime.js`, not a
   mock event emitter. Real `session_start` persists `lush.invocation`; `tool_call`
   writes a checkpoint excluding the incomplete tool-call assistant message. A FIFO
   holds the real Runner shell while a local preemption request is written: no stop
   marker appears while the tool is active. After release, real `turn_end` claims the
   request, persists `lush.preempted`, and suppresses the automatic next model call.
   The finalized checkpoint's ancestry includes the completed tool result (Pi abort
   may append another finalized entry, so its leaf need not itself be toolResult).
   A new Runner binding/Run 2 restores the same local JSONL through SessionManager;
   the next actual Provider request includes prior user/tool history and remote file
   access succeeds. Both invocation markers persist and extension errors stay empty.
6. SDK abort travels across the Bridge, kills the shell and its same-process-group
   descendant, and waits for Runner completion. Normal shell return cleans same-group
   background work. Pre-admission abort and command timeout also stop correctly.
   On stdin EOF the Runner aborts active work; the controller retains `unknown`
   transport state and refuses new writes. It does not migrate or rerun work.

## Limits / not demonstrated

- Same-host processes are **not** a sandbox or real network/SSH evidence. The trusted
  shell can access anything permitted to its OS user. Path checks are illustrative,
  not race-proof openat confinement. Escaped sessions/daemonized children need an
  OS job/cgroup and a stronger exit acknowledgement in production.
- In-memory duplicate rejection and binding are not persistent idempotency, expiring
  leases, per-user authentication or durable execution receipts. EOF is not a network
  heartbeat/watchdog. No reconnect, crash recovery, daemon restart, bounded protocol
  framing/backpressure, global resource scheduler or post-crash process ownership is
  claimed. An unknown execution must remain unknown until independently reconciled.
- AGENTS scope discovery is verified, not enforcement of instruction ordering. A
  newly encountered nested scope is returned with the file result; production must
  arrange discovery **before its first mutation**, not assume instructions delivered
  after a write retroactively governed it. No arbitrary remote project resources are
  executed; supporting skills/extensions/MCP requires a separately reviewed contract.
- Local startup/decision files are deliberately denied by code tools. A bounded,
  identifier-based control-file/cooperation channel (including `lushc` and question
  submission) still needs production design/integration. This fixture is not a
  substitute for that channel, and does not route by guessing shell command strings.
- Raw SDK `session.executeBash()` and CLI `@file`/RPC shell entry points can bypass
  custom model tools. They must not be exposed by the controlled production host;
  simply adding a remote extension or `--no-extensions` does not establish isolation.
- No production configuration gate has been installed. Local Pi compatibility,
  arbitrary custom extensions, Codex, default Pi mode, TUI previews and CLI mode
  have not been changed or claimed supported by this slice.
- No Git transfer, fixed-commit acceptance, parent/child merge, dirty-state backup,
  commit-associated checkpoint validation/fork, full project lifecycle or real remote-machine
  acceptance/performance measurement. Only committed objects and necessary logs
  should cross the eventual production delivery boundary; this fixture does not
  implement that boundary.

## SDK versus the current `--print` CLI

This evidence does **not** decide to replace the production Provider. The following
are adapter responsibilities if W298 chooses a controlled SDK bootstrap:

| Current `src/agent/provider.js` behavior | SDK feasibility / remaining adaptation |
| --- | --- |
| CLI `--extension PI_RUNTIME` implicitly binds lifecycle | Explicitly load the fixed factory and call `bindExtensions`; invocation/checkpoint/preemption verified above. The prototype uses the shipped `core/extensions/loader.js` submodule, **not a stable root export**. Version-gate it or validate a safe public loader alternative. |
| `--session-dir`, stable `--session-id`, cross-mode segregation | Explicit SessionManager create/open and local persistence work. Production must retain deterministic IDs, correct selection/ownership and mode separation rather than glob-opening arbitrary sessions. |
| `--fork` from commit-associated checkpoint | Not covered by this fixture. Reuse `forkCheckpoint` ownership/commit validation and preserve existing branch ancestry semantics; ordinary open/resume is not fork evidence. |
| `--append-system-prompt` / `--system-prompt` and local `@input` | Explicit resource loader/prompt input replaces CLI file expansion. Preserve Lush composition and snapshot semantics; do not expose generic local file reads to the model. |
| `--no-*`, explicit skills/extensions, `--no-approve` | No discovery here; only the fixed runtime factory is allowed. Custom resources and built-in Lush Skill access still require the separately bounded control-resource channel. This does not preserve arbitrary CLI resource combinations. |
| Managed connection snapshot, model/thinking and outbound policy | Loopback ModelRuntime selection is proven, not real-account parity. Keep endpoint/credential pinning, environment isolation, error redaction and local-only observation collection. |
| `spawnAgent` process guard, callbacks, preemption classification | SDK abort plus Runner stop barrier work in the fixture. Production must still own subprocess cancellation/kill guards, delivery callbacks, stop-file classification and remote unknown-state barriers. SDK `agent_end` alone is not a process-exit receipt. |
| CLI final text, exit status, transcript/usage observation | SDK messages/events are available, but the production result/usage/error adapter is not implemented. Soft-budget logic, provider-header observations and daemon restart recovery were not exercised by this lifecycle scenario. |

Smallest tested reusable host boundary is
`createControlledSession({ entry, config, bridge, controlDir, modelUrl, runtimeContext?, sessionFile? })`
returning `prompt/abort/subscribe/inspect/close`. Keep model/account runtime local,
provide the trusted extension context locally, and wait for `close` plus a durable
Runner stop receipt before releasing production write authority. Do not expose the
raw SDK session just to mimic CLI RPC. The permission checks remain at **both**
Bridge and execution endpoint, independent of SDK registration.

## Documentation consulted

Installed Pi docs were read completely: `sdk.md`, `extensions.md`,
`configuration.md`, `settings.md`, `custom-provider.md`, `cli-integration.md`,
`skills.md`, `prompt-templates.md`, `security.md`, `containerization.md`, `tui.md`,
`packages.md`, `models.md`, `session-format.md`, `message-types.md`; SDK examples
`05-tools.ts`, `06-extensions.ts`, `07-context-files.ts`, `12-full-control.ts` and
extension `ssh.ts`. Public exports and actual resource/tool/model implementations
were checked against 1.0.4. The SSH example's optional local fallback and raw shell
composition are specifically **not** copied here.
