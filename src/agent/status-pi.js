// Internal optional-Pi SDK probe. Never create a session or load extensions.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [packageDir, inputFile] = process.argv.slice(2);
const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
// Even a future SDK must not turn a metadata read into a network request.
globalThis.fetch = async () => { throw new Error('network is disabled for metadata discovery'); };
const load = file => import(pathToFileURL(path.join(packageDir, 'dist', 'core', file)).href);
const result = { models: null, packages: null };
try {
  const { ModelRuntime } = await load('model-runtime.js');
  const { AuthStorage } = await load('auth-storage.js');
  const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: input.models_file,
    refreshOnCreate: false, allowModelNetwork: false });
  result.models = [...runtime.getModels()].slice(0, 5000).map(model => ({
    provider: model.provider, id: model.id, label: model.name,
    context: model.contextWindow, max_output: model.maxTokens,
    thinking: Boolean(model.reasoning), images: Boolean(model.input?.includes('image')),
  }));
} catch {}
try {
  const { DefaultPackageManager } = await load('package-manager.js');
  const manager = new DefaultPackageManager({ cwd: input.project, agentDir: input.config_dir,
    settingsManager: { getGlobalSettings: () => input.global_settings, getProjectSettings: () => input.project_settings } });
  result.packages = manager.listConfiguredPackages().slice(0, 200).map(item => {
    // SDK paths describe intended installation locations, not proof that a package exists.
    let root = null;
    try { if (item.installedPath && fs.statSync(item.installedPath)) root = item.installedPath; } catch {}
    return { source: item.source, root };
  });
} catch {}
console.log(JSON.stringify(result));
