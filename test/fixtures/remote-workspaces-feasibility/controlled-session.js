import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertSupportedConfiguration, createRemoteTools, TOOL_NAMES } from './registry.js';

/** SDK entry, intentionally narrower than CLI/RPC or the raw AgentSession API. */
export async function createControlledSession({ entry, config, bridge, controlDir, modelUrl, runtimeContext, sessionFile }) {
  assertSupportedConfiguration(config); // Caller also checks this before starting the Runner.
  const pi = await import(pathToFileURL(entry).href);
  for (const name of ['createAgentSession', 'createExtensionRuntime', 'ModelRuntime', 'SessionManager', 'SettingsManager']) {
    if (!pi[name]) throw new Error(`Unsupported installed Pi: missing ${name}`);
  }
  const remote = await bridge.call('hello');
  if (JSON.stringify(remote.tools) !== JSON.stringify(TOOL_NAMES)) throw new Error('Runner tool capability mismatch');
  const agentsFiles = await bridge.call('context');
  const runtime = pi.createExtensionRuntime();
  const extensions = [], extensionErrors = [];
  if (runtimeContext) {
    // Fixed, reviewed production extension—not caller-selected code or simulated events.
    // This shipped submodule is not a root SDK export; production must version-check it
    // or use an equivalently controlled public DefaultResourceLoader factory path.
    const { loadExtensionFromFactory } = await import(pathToFileURL(path.join(path.dirname(entry), 'core/extensions/loader.js')).href);
    const { default: lushRuntime } = await import('../../../src/agent/pi-runtime.js');
    const previous = process.env.LUSH_RUNTIME_CONTEXT;
    try {
      process.env.LUSH_RUNTIME_CONTEXT = JSON.stringify(runtimeContext);
      extensions.push(await loadExtensionFromFactory(lushRuntime, controlDir, pi.createEventBus(), runtime, '<trusted-lush-runtime>'));
    } finally {
      if (previous === undefined) delete process.env.LUSH_RUNTIME_CONTEXT;
      else process.env.LUSH_RUNTIME_CONTEXT = previous;
    }
  }
  const resourceLoader = {
    // Do not call DefaultResourceLoader: even disabled extensions leave other discovery paths.
    getExtensions: () => ({ extensions, errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles }),
    getSystemPrompt: () => `Controlled Lush Pi feasibility fixture. Code workspace: ${remote.root}. Local cwd is control-only. All code tools go to Runner.`,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => { throw new Error('Remote resource extension unsupported'); },
    reload: async () => {},
  };
  const modelRuntime = await pi.ModelRuntime.create({ authPath: path.join(controlDir, 'isolated-auth.json'),
    modelsPath: null, modelsStorePath: path.join(controlDir, 'model-cache.json'), refreshOnCreate: false, allowModelNetwork: false });
  // Real built-in OpenAI-compatible transport, with a loopback scripted model endpoint.
  modelRuntime.registerProvider('feasibility', { api: 'openai-completions', baseUrl: modelUrl, apiKey: 'fixture-not-a-credential',
    models: [{ id: 'controlled', name: 'Controlled', reasoning: false, input: ['text', 'image'],
      contextWindow: 64000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const { session } = await pi.createAgentSession({ cwd: controlDir, agentDir: path.join(controlDir, 'agent'),
    tools: [...TOOL_NAMES], customTools: createRemoteTools(pi, bridge, remote.root),
    modelRuntime, model: modelRuntime.getModel('feasibility', 'controlled'), thinkingLevel: 'off', resourceLoader,
    settingsManager: pi.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off',
      enableSkillCommands: false, images: { autoResize: false } }),
    sessionManager: sessionFile
      ? pi.SessionManager.open(sessionFile, path.join(controlDir, 'sessions'), controlDir)
      : pi.SessionManager.create(controlDir, path.join(controlDir, 'sessions')),
  });
  await session.bindExtensions({ mode: 'print', onError: error => extensionErrors.push(error) });
  // No raw session.executeBash, pi.exec, CLI @files, CLI plugins, reload or MCP entry point exposed.
  return {
    version: pi.VERSION, remote, activeTools: session.getActiveToolNames(),
    prompt: text => session.prompt(text), abort: () => session.abort(),
    subscribe: listener => session.subscribe(listener),
    inspect: () => ({ messages: session.messages, systemPrompt: session.systemPrompt,
      sessionFile: session.sessionManager.getSessionFile(), activeTools: session.getActiveToolNames(), extensionErrors: [...extensionErrors] }),
    close: async () => { await session.abort(); session.dispose(); await bridge.close(); },
  };
}
