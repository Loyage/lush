/**
 * Which code is answering.
 *
 * A daemon is a long-lived process: the shared guide, the CLI declaration and
 * the templates are loaded once at startup and then stay in memory. The socket
 * path only says *where the state lives* (`LUSH_HOME`), never *which checkout*
 * — and because `just` exports a repo-local `LUSH_HOME`, a `daemon-restart`
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
 * points agents at) and the templates (system prompts plus the spawn
 * contract). Runtime internals are intentionally out of scope: they change
 * behavior, not instructions.
 */
const SURFACE_FILES = ['src/agent/guide.js', 'src/cli/main.js'];
const SURFACE_DIRS = ['templates'];

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
 * fingerprints mean two processes were started from identical code.
 */
export function codeFingerprint() {
  const hash = createHash('sha256');
  hash.update('lush-code-v1\n');
  for (const relative of SURFACE_FILES) addFile(hash, relative);
  for (const directory of SURFACE_DIRS) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(ROOT, directory)).filter((name) => name.endsWith('.json')).sort();
    } catch {
      /* no such directory: the empty surface is still part of the identity */
    }
    for (const name of names) addFile(hash, `${directory}/${name}`);
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

/** `{ code_dir, version, fingerprint }` of the code this process is running. */
export function codeIdentity() {
  cached ??= { code_dir: ROOT, version: codeVersion(), fingerprint: codeFingerprint() };
  return { ...cached };
}

/**
 * Compare a daemon's reported identity with this process's own. Returns null
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
