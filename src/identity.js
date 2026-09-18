/**
 * Which code is answering.
 *
 * A daemon is a long-lived service: the shared guide, the CLI declaration and
 * the templates are loaded once at startup and then stay in memory. The socket
 * path only says *where the state lives* (`LUSH_HOME`), never *which checkout*
 * — and because the `bun run` scripts export a repo-local `LUSH_HOME`, a `daemon-restart`
 * can silently restart a daemon next to the one that is actually answering.
 *
 * So both sides compute the same identity from their own checkout and compare
 * it: `code_dir` catches another checkout, `fingerprint` catches an older
 * start of this one. Identity is deliberately cheap (a few small source files)
 * so a CLI can compute it on every invocation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Repository root of the code currently running (this file lives in `src/`). */
const ROOT = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

/**
 * What decides what an agent is told: the shared guide (the prompts every call
 * carries), the CLI declaration (the tree `lush help` renders and the guide
 * points agents at), the templates (system prompts plus the construct contract) and
 * the built-in agent profile (`src/agent/profiles.js`). The last one is how much
 * of pi's own configuration an agent gets: the pure-pi flag set decides whether
 * the user's extensions, skills, prompt templates and AGENTS.md are loaded at
 * all, so a daemon started before a change there must be restarted. Runtime
 * internals are intentionally out of scope: they change behavior, not
 * instructions.
 */
const SURFACE_FILES = ['src/agent/guide.js', 'src/agent/profiles.js', 'src/cli/main.js'];
const SURFACE_DIRS = [
  // Templates are nested (the layout mirrors the construct tree), so the walk has to
  // descend: a nested template file is as much part of the surface as a flat one.
  { path: 'templates', extension: '.json', recursive: true },
  // A template's prose may live in a `@`-referenced markdown file next to it
  // (`src/template_loader.js`); that file decides what an agent is told just as
  // much as the JSON does, so it is part of the same surface.
  { path: 'templates', extension: '.md', recursive: true },
  // The command tree is the CLI declaration agents are pointed at; it lives in
  // its own directory so `main.js` stays an entry point.
  { path: 'src/cli/tree', extension: '.js' },
];

/** Relative paths under `directory` whose name ends with `extension`, sorted. */
function surfaceFiles(directory, extension, recursive = false) {
  const found = [];
  const walk = (relative) => {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(ROOT, directory, relative), { withFileTypes: true });
    } catch {
      return; // no such directory: the empty surface is still part of the identity
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const nested = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (recursive) walk(nested);
      } else if (entry.name.endsWith(extension)) {
        found.push(`${directory}/${nested}`);
      }
    }
  };
  walk('');
  return found;
}

function addFile(hash, relative) {
  let content = null;
  try {
    content = fs.readFileSync(path.join(ROOT, relative));
  } catch {
    /* a missing surface file is part of the identity, not an error */
  }
  hash.update(content === null ? `${relative}:missing\n` : `${relative}:${content.length}\n`);
  if (content !== null) hash.update(content);
  hash.update('\n');
}

/**
 * Short stable digest of the loaded prompt/declaration surface. Equal
 * fingerprints mean two services were started from identical code.
 */
export function codeFingerprint() {
  const hash = createHash('sha256');
  hash.update('lush-code-v1\n');
  for (const relative of SURFACE_FILES) addFile(hash, relative);
  for (const { path: directory, extension, recursive } of SURFACE_DIRS) {
    for (const relative of surfaceFiles(directory, extension, recursive)) addFile(hash, relative);
  }
  return hash.digest('hex').slice(0, 12);
}

export function codeVersion() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

let cached = null;

/** `{ code_dir, version, fingerprint }` of the code this service is running. */
export function codeIdentity() {
  cached ??= { code_dir: ROOT, version: codeVersion(), fingerprint: codeFingerprint() };
  return { ...cached };
}

/**
 * Compare a daemon's reported identity with this service's own. Returns null
 * when they match, otherwise one human sentence saying why they do not — a
 * daemon that predates this feature reports nothing and is treated as stale.
 */
export function codeMismatch(daemon, local = codeIdentity()) {
  if (daemon === null || daemon === undefined
    || typeof daemon.code_dir !== 'string' || typeof daemon.fingerprint !== 'string') {
    return 'daemon did not report which code it runs';
  }
  if (daemon.code_dir !== local.code_dir) {
    return `different checkout: daemon ${daemon.code_dir}, cli ${local.code_dir}`;
  }
  if (daemon.fingerprint !== local.fingerprint) {
    return `older start of this checkout: daemon fingerprint ${daemon.fingerprint}, cli ${local.fingerprint}`;
  }
  return null;
}
