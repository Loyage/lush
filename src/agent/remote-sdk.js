import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import lushRuntime from './pi-runtime.js';
import { REMOTE_PI_VERSION, REMOTE_TOOLS, REMOTE_TOOL_NAMES, sameRemoteIdentity } from './remote-contract.js';

/** Only documented root SDK exports. No private extension-loader import or ambient resource execution. */
export async function loadRemotePi(entry) {
  const pi = await import(pathToFileURL(entry).href);
  if (pi.VERSION !== REMOTE_PI_VERSION) throw new Error(`Remote Lush Pi requires verified SDK ${REMOTE_PI_VERSION}`);
  for (const name of ['createAgentSession', 'DefaultResourceLoader', 'ModelRuntime', 'SessionManager', 'SettingsManager']) {
    if (typeof pi[name] !== 'function') throw new Error(`Remote Lush Pi SDK is missing public API ${name}`);
  }
  for (const [owner, name] of [['SessionManager', 'create'], ['SessionManager', 'open'], ['SessionManager', 'forkFrom'],
    ['ModelRuntime', 'create'], ['SettingsManager', 'inMemory']]) {
    if (typeof pi[owner][name] !== 'function') throw new Error(`Remote Lush Pi SDK is missing ${owner}.${name}`);
  }
  return pi;
}
export function createRemoteTools(bridge, startupAck) {
  return REMOTE_TOOLS.map(tool => ({ ...tool, label: tool.name,
    execute: async (_id, args, signal) => {
      try {
        return await bridge.call('tool', { name: tool.name, args: ['edit', 'write', 'bash'].includes(tool.name)
          ? { context_ack: startupAck, ...args } : args }, { signal });
      } catch (error) {
        // Updated rules must pass through a model-visible result before the model can acknowledge them.
        // Never auto-update startupAck during parallel sibling execution.
        if (error.code === 'CONTEXT_REQUIRED') return { content: [{ type: 'text', text: JSON.stringify({
          error: error.message, context: error.details, instruction: 'Read these rules; pass their fingerprint as context_ack on your next mutation.' }) }],
          details: undefined, isError: true };
        throw error;
      }
    },
  }));
}
/** Controlled SDK process integration; modelRuntime is the private managed snapshot runtime.
 * No raw AgentSession, executeBash, reload, extension context or generic local executor is exposed to the caller/model.
 */
export async function createRemoteSession({ pi, descriptor, bridge, cwd, agentDir, modelRuntime, model, thinkingLevel,
  settings = {}, systemPrompt, sessionDir, sessionId, forkFile = null }) {
  const hello = await bridge.call('hello');
  if (!sameRemoteIdentity(hello.identity, descriptor.identity) || hello.path !== descriptor.path
    || JSON.stringify(hello.tools) !== JSON.stringify(REMOTE_TOOL_NAMES)) throw new Error('Remote Bridge tool/identity mismatch');
  const context = await bridge.call('context');
  if (!context.complete) throw new Error('Incomplete remote project context');
  const settingsManager = pi.SettingsManager.inMemory({ ...settings, defaultProjectTrust: 'never',
    enableInstallTelemetry: false, enableAnalytics: false, cacheWarming: 'off', enableSkillCommands: false });
  let barrierFailed = false;
  const trustedRuntime = api => lushRuntime(new Proxy(api, { get(target, key) {
    if (key !== 'on') return Reflect.get(target, key);
    return (name, handler) => api.on(name, name !== 'turn_end' ? handler : async (event, ctx) => {
      // A resolved/rejected local tool Promise alone is not evidence of remote stop (e.g. a lost
      // socket response). Gate BOTH checkpoint and preemption markers on a current remote barrier.
      let stopped = false;
      try { stopped = (await bridge.call('idle', {}, { timeout_ms: 15000 })).stopped === true; } catch { /* unknown */ }
      if (!stopped) { barrierFailed = true; ctx.abort(); return; }
      return handler(event, ctx);
    });
  } }));
  // DefaultResourceLoader's PUBLIC inline factory API loads ONLY the trusted runtime.
  // Discovery is disabled in every category, including AGENTS and prompt files.
  const resourceDir = fs.mkdtempSync(path.join(agentDir, 'remote-resources-'));
  const loader = new pi.DefaultResourceLoader({ cwd: resourceDir, agentDir: resourceDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [trustedRuntime],
    systemPrompt: systemPrompt + '\n\nRemote startup context_ack: ' + context.fingerprint
      + '\nCentral control resource IDs: ' + JSON.stringify(hello.control_resources),
    appendSystemPrompt: [],
    agentsFilesOverride: () => ({ agentsFiles: context.files.map(file => ({ path: path.posix.join(descriptor.path, file.path), content: file.content })) }),
  });
  await loader.reload();
  if (loader.getExtensions().errors.length) throw new Error('Trusted remote runtime could not be loaded');
  // Subsequent discovery/reload is unsupported, not an opportunity to discover local/remote resources.
  const resourceLoader = {
    getExtensions: () => loader.getExtensions(), getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => loader.getAgentsFiles(), getSystemPrompt: () => loader.getSystemPrompt(),
    getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => { throw new Error('Remote resources are unsupported'); }, reload: async () => { throw new Error('Remote resource reload is unsupported'); },
  };
  const existing = fs.readdirSync(sessionDir).filter(name => name.endsWith(`_${sessionId}.jsonl`));
  if (existing.length > 1) throw new Error('Ambiguous remote session identity');
  const sessionManager = existing.length ? pi.SessionManager.open(path.join(sessionDir, existing[0]), sessionDir, cwd)
    : forkFile ? pi.SessionManager.forkFrom(forkFile, cwd, sessionDir, { id: sessionId })
      : pi.SessionManager.create(cwd, sessionDir, { id: sessionId });
  const { session } = await pi.createAgentSession({ cwd, agentDir, modelRuntime, model, thinkingLevel,
    settingsManager, resourceLoader, sessionManager, tools: [...REMOTE_TOOL_NAMES],
    customTools: createRemoteTools(bridge, context.fingerprint) });
  const errors = [];
  await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
  if (JSON.stringify(session.getActiveToolNames().sort()) !== JSON.stringify([...REMOTE_TOOL_NAMES].sort())) {
    session.dispose(); throw new Error('Remote Pi active tools differ from Bridge registration');
  }
  return {
    prompt: async text => {
      await session.prompt(text, { expandPromptTemplates: false });
      if (barrierFailed) throw new Error('Remote turn stop remains unknown');
      if (errors.length) throw new Error('Trusted remote runtime handler failed');
      const last = session.messages.findLast(message => message.role === 'assistant');
      if (['error', 'aborted'].includes(last?.stopReason)) throw new Error('Remote model invocation failed or aborted');
      return session.getLastAssistantText() ?? '';
    },
    abort: () => session.abort(), subscribe: listener => session.subscribe(listener),
    inspect: () => ({ activeTools: session.getActiveToolNames(), messages: session.messages,
      sessionFile: session.sessionManager.getSessionFile(), systemPrompt: session.systemPrompt }),
    close: async () => { await session.abort(); session.dispose(); },
  };
}
