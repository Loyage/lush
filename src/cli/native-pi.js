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
  let pi, tui, themeApi;
  try {
    checkInstallation(entry);
    pi = await import(pathToFileURL(entry).href);
    const tuiEntry = createRequire(entry).resolve(TUI_PACKAGE);
    tui = await import(pathToFileURL(tuiEntry).href);
    // Pi 1.0's root exports components, but its terminal-derived system palette setters
    // live in this shipped presentation module. Refuse versions missing this narrow seam.
    themeApi = await import(pathToFileURL(path.join(path.dirname(entry), 'modes/interactive/theme/theme.js')).href);
  } catch { throw incompatible(); }
  const requiredPi = ['AssistantMessageComponent', 'UserMessageComponent', 'ToolExecutionComponent', 'initTheme',
    'getMarkdownTheme', 'createReadToolDefinition', 'createBashToolDefinition', 'createEditToolDefinition', 'createWriteToolDefinition'];
  const requiredTui = ['ProcessTerminal', 'TuiAltScreen', 'ScrollView', 'VStack', 'Text', 'Container', 'matchesKey', 'truncateToWidth', 'visibleWidth'];
  const requiredTheme = ['setTerminalColors', 'setTerminalColorScheme', 'detectTerminalTheme'];
  if (requiredPi.some(key => typeof pi[key] !== 'function') || requiredTui.some(key => typeof tui[key] !== 'function')
    || requiredTheme.some(key => typeof themeApi[key] !== 'function')
    || ['setLayoutRoot', 'addInputListener', 'onTerminalColorSchemeChange', 'setTerminalColorSchemeNotifications']
      .some(key => typeof tui.TuiAltScreen.prototype[key] !== 'function')
    || ['getContentWidth', 'updateLayout', 'scrollTo', 'scrollBy', 'scrollToEnd']
      .some(key => typeof tui.ScrollView.prototype[key] !== 'function')) throw incompatible();
  try {
    // System is reserved: unlike named themes it never loads a user's theme file or watcher.
    // A guessed foreground must not be announced as an actual terminal default: Pi
    // would emit SGR 39 for panel titles, which could be black on a guessed dark panel.
    themeApi.setTerminalColors({ background: fallbackTerminalColors(env).background });
    pi.initTheme('system', false);
    if (['getBgAnsi', 'bg', 'fg'].some(key => typeof themeApi.theme?.[key] !== 'function')) throw incompatible();
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
    const appearance = {
      apply(colors, scheme) {
        themeApi.setTerminalColorScheme(scheme);
        themeApi.setTerminalColors({ background: fallbackTerminalColors(env, themeApi.detectTerminalTheme(colors, scheme, env)).background, ...colors });
        pi.initTheme('system', false);
      },
      theme: themeApi.theme,
    };
    const assistant = message => {
      // The native component accepts a Markdown theme. Add only code-panel backgrounds;
      // preserve Pi's own Markdown parsing, language highlighting and text rendering.
      const markdown = pi.getMarkdownTheme(), bg = text => appearance.theme.bg('toolSuccessBg', text);
      const component = new pi.AssistantMessageComponent(message, false, {
        ...markdown,
        codeBlock: text => bg(markdown.codeBlock(text)),
        codeBlockBorder: text => bg(markdown.codeBlockBorder(text)),
        highlightCode: (code, language) => markdown.highlightCode(code, language).map(bg),
      });
      return {
        invalidate() { component.invalidate(); },
        render(width) {
          const prefix = appearance.theme.getBgAnsi('toolSuccessBg');
          return component.render(width).map(line => line.includes(prefix)
            ? prefix + line.replace(/\x1b\[(?:0|49)m/g, reset => reset + prefix)
              + ' '.repeat(Math.max(0, width - tui.visibleWidth(line))) + '\x1b[49m'
            : line);
        },
      };
    };
    return { pi, tui, renderers, entry, appearance, assistant };
  } catch { throw incompatible(); }
}

/** Explicit fallback seeds the reserved system theme's contrast calculation, rather than
 * loading a named dark/light theme that a user may override. Unknown terminals default dark;
 * COLORFGBG or a native appearance notification can provide a light fallback. */
export function fallbackTerminalColors(env = process.env, scheme) {
  const index = Number((env.COLORFGBG || '').split(';').at(-1));
  const light = scheme ? scheme === 'light' : Boolean(env.COLORFGBG) && Number.isInteger(index) && index >= 7 && index <= 15 && index !== 8;
  return light ? { foreground: { r: 24, g: 24, b: 24 }, background: { r: 255, g: 255, b: 255 } }
    : { foreground: { r: 229, g: 229, b: 231 }, background: { r: 0, g: 0, b: 0 } };
}

/** Native OSC queries, without TUI's uncancellable pending-query timer. ProcessTerminal splits
 * terminal sequences; the listener consumes only complete color/DA replies, never log text.
 * One 100ms startup budget, then late colors still apply. All listeners/timers are disposable. */
export function watchTerminalColors(runtime, ui, onChange, onError = () => {}, timers = { setTimeout, clearTimeout }) {
  let active = true, timer, scheme, reported = {}, palette = [], readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const apply = () => {
    if (!active) return;
    try {
      runtime.appearance.apply({ ...reported, ...(Array.from({ length: 16 }, (_, i) => palette[i]).every(Boolean) ? { palette: [...palette] } : {}) }, scheme);
      onChange();
    } catch (error) { onError(error); }
  };
  const settle = () => { timers.clearTimeout(timer); timer = undefined; readyResolve(); };
  const query = () => {
    timers.clearTimeout(timer);
    timer = timers.setTimeout(() => { timer = undefined; apply(); readyResolve(); }, 100);
    ui.terminal.write('\x1b]10;?\x1b\\\x1b]11;?\x1b\\'
      + Array.from({ length: 16 }, (_, i) => `\x1b]4;${i};?\x1b\\`).join('') + '\x1b[c');
  };
  const unsubscribe = ui.addInputListener(data => {
    const match = /^\x1b\](?:(10|11)|4;(\d{1,3}));([^\x07\x1b]{1,32})(?:\x07|\x1b\\)$/i.exec(data);
    const value = match?.[3];
    const channels = value?.startsWith('#') && /^(?:#[0-9a-f]{6}|#[0-9a-f]{12})$/i.test(value)
      ? value.slice(1).match(new RegExp(`.{${(value.length - 1) / 3}}`, 'g'))
      : /^(?:rgb:)?[0-9a-f]{1,4}\/[0-9a-f]{1,4}\/[0-9a-f]{1,4}$/i.test(value || '') ? value.replace(/^rgb:/i, '').split('/') : null;
    if (channels) {
      const rgb = Object.fromEntries(['r', 'g', 'b'].map((key, i) => [key, Math.round(parseInt(channels[i], 16) / (16 ** channels[i].length - 1) * 255)]));
      if (match[1]) reported[match[1] === '10' ? 'foreground' : 'background'] = rgb;
      else if (Number(match[2]) < 16) palette[Number(match[2])] = rgb;
      apply(); return { consume: true };
    }
    if (/^\x1b\[(?:\?|>)[\d;]*c$/.test(data)) { settle(); return { consume: true }; }
    // Invalid color replies are still protocol, not keyboard actions (notably Escape).
    if (/^\x1b\](?:10|11|4);/.test(data)) return { consume: true };
    return undefined;
  });
  const unsubscribeScheme = ui.onTerminalColorSchemeChange(value => {
    scheme = value; reported = {}; palette = []; apply(); query();
  });
  const dispose = () => {
    if (!active) return;
    active = false; settle(); unsubscribe(); unsubscribeScheme(); ui.setTerminalColorSchemeNotifications(false);
  };
  try { ui.setTerminalColorSchemeNotifications(true); query(); }
  catch (error) { dispose(); throw error; }
  return { ready, dispose };
}
