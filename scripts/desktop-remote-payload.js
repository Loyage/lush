import fs from 'node:fs';
import path from 'node:path';
import { BUILD_DIR, TARGETS, remoteSourceIdentity, verifyRemotePayload } from './build-remote.js';

export const REMOTE_RESOURCE_FILES = Object.freeze(['manifest.json', ...TARGETS.map(target => `lush-remote-${target}.tar.gz`)]);
export const DESKTOP_PAYLOAD_DIR = 'node_modules/lush-desktop-build/remote-payload';

function noSymlinks(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`Remote resource path must not be a symlink: ${current}`);
  }
  return absolute;
}

/** Never install or execute Linux binaries on the client; verify their declared source identity. */
export function verifyDesktopRemotePayload(root, directory, { stagedDir } = {}) {
  const manifest = verifyRemotePayload(noSymlinks(directory), { requireTargets: TARGETS });
  const expected = remoteSourceIdentity(root);
  if (manifest.lush_version !== expected.lush_version || manifest.fingerprint !== expected.fingerprint) {
    throw new Error('Remote payload does not match desktop source identity; rebuild both native payloads from this checkout');
  }
  if (stagedDir) {
    verifyRemotePayload(noSymlinks(stagedDir), { requireTargets: TARGETS });
    for (const name of REMOTE_RESOURCE_FILES) {
      if (!fs.readFileSync(path.join(directory, name)).equals(fs.readFileSync(path.join(stagedDir, name)))) {
        throw new Error(`Packaged remote resource differs from staged payload: ${name}`);
      }
    }
  }
  return manifest;
}

/** Reviewed Linux payloads are separate resources, never executable Windows application modules. */
export function stageDesktopRemotePayload(root, { payloadDir = path.join(root, BUILD_DIR) } = {}) {
  verifyDesktopRemotePayload(root, payloadDir);
  const directory = noSymlinks(path.join(root, DESKTOP_PAYLOAD_DIR));
  const parent = path.dirname(directory);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, 'remote-payload-stage-'));
  try {
    for (const name of REMOTE_RESOURCE_FILES) fs.copyFileSync(path.join(payloadDir, name), path.join(temporary, name));
    verifyDesktopRemotePayload(root, temporary);
    // Only this build-owned resource directory is replaced; never touch the inputs or project state.
    fs.rmSync(directory, { recursive: true, force: true });
    fs.renameSync(temporary, directory);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  return directory;
}
