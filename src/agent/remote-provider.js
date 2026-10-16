import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNativePi } from '../cli/native-pi.js';
import { AGENT_CAPABILITIES } from './capabilities.js';
import { createRuntimeConnection, readRuntimeObservations } from './connection-runtime.js';
import { piConfigDirectory, readPiConfiguration, isolatedPiEnvironment } from './pi-config.js';
import { forkCheckpoint } from './fork.js';
import { choiceForkPath, readChoiceFile } from './choice-context.js';
import { remoteWorkspacePrompt } from './prompts.js';
import { assertRemoteDescriptor, REMOTE_PI_VERSION } from './remote-contract.js';
import { RemoteBridgeClient } from './remote-bridge.js';

const BOOTSTRAP = fileURLToPath(new URL('./remote-bootstrap.js', import.meta.url));
const BUILTIN_SKILLS = new Set(AGENT_CAPABILITIES.flatMap(({ skill }) => [skill, path.dirname(skill)]));
export function assertRemoteConfiguration(agent, rawSettings = {}) {
  // normalizeAgentProfile deliberately omits the default Lush mode in persisted/retry profiles.
  // Inherited child profiles must follow that same contract, without admitting explicit Pi mode.
  if (agent?.agent !== 'pi' || (agent.config_mode ?? 'lush') !== 'lush') throw new Error('Remote workspaces support only controlled Lush Pi; no local fallback');
  for (const source of [agent, rawSettings]) {
    for (const key of ['extensions', 'mcp', 'mcpServers', 'packages', 'themes', 'prompts', 'promptTemplates', 'tools']) {
      const value = source[key];
      if (value && (typeof value !== 'object' || Object.keys(value).length)) throw new Error(`Unsupported remote Pi resource: ${key}`);
    }
    if (source.skills?.some(skill => !BUILTIN_SKILLS.has(skill))) throw new Error('Unsupported remote Pi custom skills');
    if (source.shellPath || source.shellCommandPrefix) throw new Error('Unsupported remote Pi shell override');
    if (source.defaultTools && JSON.stringify([...source.defaultTools].sort()) !== JSON.stringify(['bash', 'edit', 'read', 'write']))
      throw new Error('Unsupported remote Pi tool selection');
  }
}
function diagnoseEntry(env) {
  const entry = resolveNativePi(env);
  let dir = path.dirname(entry);
  for (;;) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) {
      const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (metadata.name === '@earendil-works/pi-coding-agent') {
        if (metadata.version !== REMOTE_PI_VERSION) throw new Error(`Remote Lush Pi requires verified SDK ${REMOTE_PI_VERSION}`);
        return entry;
      }
    }
    const parent = path.dirname(dir); if (parent === dir) throw new Error('Remote Pi npm SDK metadata is unavailable'); dir = parent;
  }
}
/** Central admission preflight: no model request, subprocess or resource loading. */
export function assertRemoteRuntime(config, agent) {
  assertRemoteConfiguration(agent, readPiConfiguration(path.join(piConfigDirectory(config), 'settings.json')));
  return diagnoseEntry(config.env);
}
/** Provider-owned guard/process/session handling; Bridge and lease lifecycle remain central-host owned.
 * See remote-contract.js for the exact optional remote_workspace descriptor.
 */
export async function runRemotePi(config, options, { sessionFiles, spawnAgent }) {
  const { task, context, messages, messagesPage, cwd, token, signal, onSpawn, onInputDelivered, onPreempt,
    agent, forkPointer, connectionRuntime, onConnectionObservation, choiceFork, remote_workspace: descriptor } = options;
  assertRemoteDescriptor(descriptor, task.id, context.invocation?.run_id);
  const entry = assertRemoteRuntime(config, agent);
  if (task.role !== 'agent' || !['order', 'child'].includes(task.task_kind) || !token) throw new Error('Remote Pi requires a development Worker invocation');
  if (!path.isAbsolute(cwd) || cwd === descriptor.path || cwd === config.project) throw new Error('Remote Pi requires a separate central control cwd');
  const bridge = new RemoteBridgeClient(descriptor, token);
  const remoteContext = await bridge.call('context');
  const files = sessionFiles(config, task, { ...context, remote_workspace: descriptor }, messages, agent, messagesPage,
    { projectSupplements: remoteContext.project_supplements });
  fs.appendFileSync(files.systemFile, '\n\n' + remoteWorkspacePrompt(config, descriptor, cwd));
  const sessionId = `lush-task-${task.id}`;
  const existing = fs.readdirSync(files.sessions).some(name => name.endsWith(`_${sessionId}.jsonl`));
  if (choiceFork) {
    if (choiceFork.file !== choiceForkPath(config.home, task.id)) throw new Error('Invalid remote choice fork ownership');
    readChoiceFile(config.home, choiceFork.file, choiceFork.digest);
  }
  const forkFile = !existing && (choiceFork || forkPointer)
    ? choiceFork?.file ?? forkCheckpoint(config.home, { ...forkPointer, commit: task.base_commit }) : null;
  const managed = createRuntimeConnection(config, agent, connectionRuntime);
  let result, failure;
  try {
    const bootstrap = path.join(managed.dir, 'remote-input.json');
    fs.writeFileSync(bootstrap, JSON.stringify({ entry, descriptor, cwd, agentDir: managed.dir, model: agent.model,
      thinking: agent.thinking, sessions: files.sessions, sessionId, forkFile, promptFile: files.promptFile, systemFile: files.systemFile }), { mode: 0o600, flag: 'wx' });
    const values = isolatedPiEnvironment(config, files.environment.values, managed.dir);
    result = await spawnAgent(process.execPath, [BOOTSTRAP, bootstrap], {
      config: { ...config, env: isolatedPiEnvironment(config, config.env, managed.dir), taskId: task.id, runId: descriptor.identity.run_id },
      cwd, token, signal, onSpawn, onInputDelivered, onPreempt,
      extraEnv: { ...values, LUSH_RUNTIME_CONTEXT: JSON.stringify({ ...context.invocation, task_id: task.id,
        role: task.role, task_kind: task.task_kind, config_mode: 'lush', soft_budget: agent.soft_budget,
        preempt_dir: path.join(config.home, 'preempt'), sessions_dir: files.sessions,
        connection: { ...managed.binding, observations_file: managed.observations } }) },
    });
  } catch (error) { failure = error; }
  finally {
    // SDK exit/SIGKILL/preemption never proves remote stop. An unknown barrier supersedes success/preemption.
    try {
      const barrier = await bridge.call('barrier');
      if (!barrier.stopped) failure = new Error('Remote stop remains unknown; preserve workspace and block delivery');
    } catch { failure = new Error('Remote stop barrier unavailable; preserve workspace and block delivery'); }
    try { for (const observation of readRuntimeObservations(managed)) await onConnectionObservation?.(observation); } catch { /* passive */ }
    fs.rmSync(managed.dir, { recursive: true, force: true });
  }
  if (failure) throw failure;
  const secret = connectionRuntime.credential.key || connectionRuntime.credential.access;
  return secret ? result.replaceAll(secret, '[redacted]') : result;
}
