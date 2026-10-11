import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGE = '@earendil-works/pi-coding-agent';
const TUI_PACKAGE = '@earendil-works/pi-tui';
const missing = () => new Error('原生观看器需要可导入的 Pi npm 安装。请安装兼容的 @earendil-works/pi-coding-agent，或通过 LUSH_PI_COMMAND 指向其 pi 可执行文件；独立二进制若不附带模块不能用于渲染。');
const incompatible = () => new Error('已安装的 Pi 与原生观看器组件接口不兼容；请更新 Pi。未启动 Agent。');

function executable(command, env) {
  if (typeof command !== 'string' || !command || command.includes('\0')) return null;
  const candidates = command.includes('/') || command.includes('\\') ? [path.resolve(command)]
    : (env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, command));
  for (const filename of candidates) {
    try {
      if (!fs.statSync(filename).isFile()) continue;
      fs.accessSync(filename, fs.constants.X_OK);
      return filename;
    } catch { /* Never execute a command to discover its package. */ }
  }
  return null;
}

function packageEntry(root) {
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (metadata.name !== PACKAGE) return null;
    // require.resolve cannot resolve newer Pi's import-only export. Read the public
    // ESM export target (never CLI/bin), with main only for pre-exports packages.
    let target = metadata.exports?.['.'] ?? metadata.exports ?? metadata.main;
    while (target && typeof target === 'object') target = target.import ?? target.default;
    if (typeof target !== 'string' || !target.startsWith('./') && metadata.exports) return null;
    const entry = path.resolve(root, target);
    if (!entry.startsWith(path.resolve(root) + path.sep) || !fs.statSync(entry).isFile()) return null;
    return entry;
  } catch { return null; }
}

/** Local resolution, then executable/symlink/npm-global/bundle-adjacent layouts. No subprocesses. */
export function resolveNativePi(env = process.env) {
  // Bun's bare import.meta.resolve can auto-install missing packages. Inspect local module
  // directories directly instead: absence must stay offline and must not mutate a package cache.
  for (const start of env.LUSH_PI_COMMAND ? [] : new Set([process.cwd(), path.dirname(fileURLToPath(import.meta.url))])) {
    let dir = start;
    while (true) {
      const entry = packageEntry(path.join(dir, 'node_modules', PACKAGE));
      if (entry) return entry;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const bin = executable(env.LUSH_PI_COMMAND || 'pi', env);
  if (!bin) throw missing();
  const starts = new Set([path.dirname(bin)]);
  try { starts.add(path.dirname(fs.realpathSync(bin))); } catch { /* Try the original layout. */ }
  for (const start of starts) {
    let dir = start;
    for (let depth = 0; depth < 10; depth++) {
      for (const root of [dir, path.join(dir, 'node_modules', PACKAGE), path.join(dir, 'lib', 'node_modules', PACKAGE)]) {
        const entry = packageEntry(root);
        if (entry) return entry;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw missing();
}

function installedPackage(name, start) {
  let dir = start;
  while (true) {
    const filename = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(filename)) return fs.realpathSync(filename);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Bun may auto-install an absent transitive dependency on import. Refuse an incomplete
// installation before any import instead of letting a display command access the network.
function checkInstallation(entry) {
  let dir = path.dirname(fs.realpathSync(entry)), root;
  while (true) {
    const filename = path.join(dir, 'package.json');
    if (fs.existsSync(filename) && JSON.parse(fs.readFileSync(filename, 'utf8')).name === PACKAGE) { root = filename; break; }
    const parent = path.dirname(dir);
    if (parent === dir) throw incompatible();
    dir = parent;
  }
  const pending = [root], seen = new Set();
  while (pending.length) {
    const filename = pending.pop();
    if (seen.has(filename)) continue;
    seen.add(filename);
    if (seen.size > 2048) throw incompatible();
    const metadata = JSON.parse(fs.readFileSync(filename, 'utf8'));
    for (const name of Object.keys(metadata.dependencies || {})) {
      // npm may legitimately skip platform-specific optional dependencies.
      if (Object.hasOwn(metadata.optionalDependencies || {}, name)) continue;
      const child = installedPackage(name, path.dirname(filename));
      if (!child) throw incompatible();
      pending.push(child);
    }
  }
}

/** Lazy, presentation only. No sessions, settings, resource discovery or custom extensions. */
export async function loadNativePi(env = process.env) {
  const entry = resolveNativePi(env);
  let pi, tui;
  try {
    checkInstallation(entry);
    pi = await import(pathToFileURL(entry).href);
    const tuiEntry = createRequire(entry).resolve(TUI_PACKAGE);
    tui = await import(pathToFileURL(tuiEntry).href);
  } catch { throw incompatible(); }
  const requiredPi = ['AssistantMessageComponent', 'UserMessageComponent', 'ToolExecutionComponent', 'initTheme',
    'createReadToolDefinition', 'createBashToolDefinition', 'createEditToolDefinition', 'createWriteToolDefinition'];
  const requiredTui = ['ProcessTerminal', 'Text', 'Container', 'matchesKey', 'truncateToWidth', 'visibleWidth'];
  if (requiredPi.some(key => typeof pi[key] !== 'function') || requiredTui.some(key => typeof tui[key] !== 'function')
    || typeof (tui.TuiMainScreen || tui.TUI) !== 'function') throw incompatible();
  try {
    // System is reserved: unlike named themes it never loads a user's theme file or watcher.
    pi.initTheme('system', false);
    const renderers = new Map();
    for (const name of ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']) {
      const factory = pi[`create${name[0].toUpperCase()}${name.slice(1)}ToolDefinition`];
      if (!factory) continue;
      const definition = factory(process.cwd());
      const renderer = { renderCall: definition.renderCall, renderResult: definition.renderResult, renderShell: definition.renderShell };
      if (name === 'edit') {
        // Pi's edit preview otherwise reads current files via computeEditsDiff(). A historical viewer
        // must not read that unrelated live filesystem or fabricate a diff from missing details.
        renderer.renderCall = (args, theme, context) => {
          const container = new tui.Container();
          container.addChild(definition.renderCall(args, theme, { ...context, argsComplete: false }));
          container.addChild(new tui.Text(JSON.stringify(args, null, 2), 1, 0));
          return container;
        };
        renderer.renderResult = result => new tui.Text(result.content.map(part => part.text || '').join('\n'), 1, 0);
      }
      renderers.set(name, Object.freeze(renderer));
    }
    return { pi, tui, renderers, entry };
  } catch { throw incompatible(); }
}
