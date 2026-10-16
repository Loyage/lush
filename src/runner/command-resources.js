import fs from 'node:fs';
import path from 'node:path';
import { check, stable, identifier } from './protocol.js';
import { createCgroupController, commandGroupName } from './cgroup.js';

const CONTAINER = 'command_homes_v1';
const statIdentity = directory => {
  const stat = fs.lstatSync(directory, { bigint: true });
  check(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(directory) === directory,
    'STALE', 'Command resource directory is not canonical');
  return { dev: String(stat.dev), ino: String(stat.ino) };
};
const same = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
const present = directory => { try { fs.lstatSync(directory); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

/** Called under RunnerStore's initialization lock. Old command-homes are never adopted. */
export function initializeCommandResourceContainer(store) {
  if (store.db.query('SELECT value FROM node_metadata WHERE key=?').get(CONTAINER)) return;
  const directory = path.join(store.root, 'command-homes-v1');
  const planned = { version: 1, runner_id: store.runner_id, directory, state: 'creating' };
  store.db.query('INSERT INTO node_metadata(key,value) VALUES (?,?)').run(CONTAINER, JSON.stringify(planned));
  // An existing or interrupted unregistered directory remains unknown, not retroactively owned.
  if (present(directory)) return;
  fs.mkdirSync(directory, { mode: 0o700 });
  store.db.query('UPDATE node_metadata SET value=? WHERE key=?')
    .run(JSON.stringify({ ...planned, state: 'ready', ...statIdentity(directory) }), CONTAINER);
}
function container(store) {
  const value = JSON.parse(store.db.query('SELECT value FROM node_metadata WHERE key=?').get(CONTAINER)?.value ?? 'null');
  check(value?.state === 'ready' && value.runner_id === store.runner_id && value.directory === path.join(store.root, 'command-homes-v1')
    && same(value, statIdentity(value.directory)), 'UNKNOWN', 'Command home container ownership is not confirmed');
  return value;
}
export function resourceRow(store, execution_id) {
  const row = store.db.query('SELECT * FROM command_resources WHERE execution_id=?').get(execution_id);
  return row ? { ...row, home: JSON.parse(row.home_json ?? 'null'), containment: JSON.parse(row.containment_json ?? 'null') } : null;
}
export function beginCommandResources(store, execution) {
  identifier(execution.execution_id, 'execution_id');
  check(!resourceRow(store, execution.execution_id), 'UNKNOWN', 'Command resources were already prepared; do not replay');
  store.db.query(`INSERT INTO command_resources(execution_id,workspace_key,runner_id,phase,home_state,cgroup_state)
    VALUES (?,?,?,'unallocated','absent','absent')`).run(execution.execution_id, execution.workspace_key, store.runner_id);
}
export function beginContainmentCreation(store, execution) {
  container(store); // Refuse new OS resource creation if the shared home container is already unknown.
  check(resourceRow(store, execution.execution_id)?.phase === 'unallocated', 'UNKNOWN', 'Command resource phase changed');
  store.db.query("UPDATE command_resources SET phase='preparing',cgroup_state='creating' WHERE execution_id=?").run(execution.execution_id);
}
export function recordCommandContainment(store, execution, receipt) {
  const resource = resourceRow(store, execution.execution_id);
  check(resource?.runner_id === store.runner_id && resource.workspace_key === execution.workspace_key
    && ['creating', 'present'].includes(resource.cgroup_state) && ['preparing', 'ready'].includes(resource.phase),
    'UNKNOWN', 'Containment creation has no matching resource receipt');
  store.db.query("UPDATE command_resources SET containment_json=?,cgroup_state='present' WHERE execution_id=?")
    .run(JSON.stringify(receipt), execution.execution_id);
}
export function createCommandHome(store, execution) {
  identifier(execution.execution_id, 'execution_id');
  const parent = container(store), directory = path.join(parent.directory, execution.execution_id);
  const resource = resourceRow(store, execution.execution_id);
  check(resource?.runner_id === store.runner_id && resource.workspace_key === execution.workspace_key
    && resource.phase === 'preparing' && resource.cgroup_state === 'present' && resource.home_state === 'absent',
    'UNKNOWN', 'Command home creation has no matching resource receipt');
  check(!present(directory), 'UNKNOWN', 'Unregistered command home exists; do not adopt it');
  const home = { version: 1, execution_id: execution.execution_id, workspace_key: execution.workspace_key,
    runner_id: store.runner_id, directory, parent, tmp_is_home: true };
  store.db.query("UPDATE command_resources SET home_json=?,home_state='creating' WHERE execution_id=?")
    .run(JSON.stringify(home), execution.execution_id);
  fs.mkdirSync(directory, { mode: 0o700 });
  const owned = { ...home, ...statIdentity(directory) };
  store.db.query("UPDATE command_resources SET home_json=?,home_state='present',phase='ready' WHERE execution_id=?")
    .run(JSON.stringify(owned), execution.execution_id);
  return directory;
}
export function verifyCommandHome(store, execution, resource = resourceRow(store, execution.execution_id)) {
  identifier(execution.execution_id, 'execution_id');
  const home = resource?.home, parent = container(store);
  check(resource?.runner_id === store.runner_id && resource.workspace_key === execution.workspace_key
    && ['present', 'removing'].includes(resource.home_state) && home?.execution_id === execution.execution_id
    && home.workspace_key === execution.workspace_key && home.runner_id === store.runner_id && home.tmp_is_home === true
    && home.directory === path.join(parent.directory, execution.execution_id) && same(home.parent, parent)
    && same(home, statIdentity(home.directory)), 'STALE', 'Command home ownership changed');
  return home.directory;
}
function containmentController(config) {
  const controller = createCgroupController(config);
  return {
    verify(receipt) {
      const directory = controller.verify(receipt);
      check(!controller.populated(receipt), 'BUSY', 'Command containment is not empty');
      return directory;
    },
    remove(receipt) {
      const directory = controller.verify(receipt);
      check(!controller.populated(receipt), 'BUSY', 'Command containment is not empty');
      fs.rmdirSync(directory);
    },
    absent(receipt) { return !present(path.join(config.cgroup_root, receipt.name)); },
  };
}
function validateStopped(store, execution, resource) {
  const fresh = store.db.query('SELECT * FROM executions WHERE execution_id=?').get(execution.execution_id);
  const spec = JSON.parse(fresh?.spec_json ?? 'null');
  check(fresh?.workspace_key === execution.workspace_key && fresh.stop_confirmed === 1 && fresh.state === 'exited',
    'BUSY', 'Command stop is not confirmed or its outcome is unknown');
  check(spec.resources_version === 1 && resource?.workspace_key === execution.workspace_key && resource.runner_id === store.runner_id,
    'UNKNOWN', 'Command resource ownership is not recorded');
  check(['ready', 'unallocated', 'removing', 'removed'].includes(resource.phase), 'UNKNOWN', 'Command resource creation is incomplete');
  if (resource.cgroup_state !== 'absent') check(fresh.cgroup_name === commandGroupName(fresh)
    && (resource.containment?.kind !== 'cgroup-v2' || resource.containment.name === fresh.cgroup_name)
    && stable(resource.containment) === stable(spec.containment)
    && ['exited', 'not_started'].includes(spec.bootstrap_state), 'UNKNOWN', 'Command containment receipt changed');
  return fresh;
}
function verifyHomeContents(directory, dev) {
  let count = 0;
  const visit = (current, depth) => {
    check(depth < 64, 'LIMIT_EXCEEDED', 'Command resource nesting exceeds cleanup budget');
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      check(++count <= 100000, 'LIMIT_EXCEEDED', 'Command resources exceed cleanup traversal budget');
      const name = path.join(current, entry.name), stat = fs.lstatSync(name, { bigint: true });
      check(String(stat.dev) === dev, 'STALE', 'Command home contains a foreign mount');
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(name, depth + 1);
      // Owned command-created links are unlinked, never traversed.
    }
  };
  visit(directory, 0);
}

/** No path/PID supplied by the request. Test controller is an explicit assembly seam, not a production fallback. */
export function commandResourceCleanup(store, executions, config, { controller = containmentController(config), guard = () => {} } = {}) {
  function verify(execution) {
    guard();
    const resource = resourceRow(store, execution.execution_id);
    validateStopped(store, execution, resource);
    if (['present', 'removing'].includes(resource.home_state)) {
      const directory = verifyCommandHome(store, execution, resource);
      verifyHomeContents(directory, resource.home.dev);
    } else if (resource.home_state === 'removed') {
      check(!present(resource.home.directory), 'STALE', 'Removed command home path was reused');
    } else check(resource.home_state === 'absent' && !resource.home
      && !present(path.join(container(store).directory, execution.execution_id)), 'UNKNOWN', 'Command home creation is unconfirmed');
    if (['present', 'removing'].includes(resource.cgroup_state)) controller.verify(resource.containment, execution);
    else if (resource.cgroup_state === 'removed') check(controller.absent(resource.containment, execution), 'STALE', 'Removed containment path was reused');
    else check(resource.cgroup_state === 'absent' && !resource.containment, 'UNKNOWN', 'Containment creation is unconfirmed');
    return resource;
  }
  // Preflight the whole set before deleting any resource.
  for (const execution of executions) verify(execution);
  return () => {
    for (const execution of executions) {
      let resource = verify(execution);
      if (['present', 'removing'].includes(resource.cgroup_state)) {
        store.db.query("UPDATE command_resources SET phase='removing',cgroup_state='removing' WHERE execution_id=?").run(execution.execution_id);
        resource = verify(execution);
        controller.remove(resource.containment, execution);
        store.db.query("UPDATE command_resources SET cgroup_state='removed' WHERE execution_id=?").run(execution.execution_id);
      }
      resource = verify(execution);
      if (['present', 'removing'].includes(resource.home_state)) {
        store.db.query("UPDATE command_resources SET phase='removing',home_state='removing' WHERE execution_id=?").run(execution.execution_id);
        resource = verify(execution);
        const directory = verifyCommandHome(store, execution, resource);
        fs.rmSync(directory, { recursive: true });
        store.db.query("UPDATE command_resources SET home_state='removed' WHERE execution_id=?").run(execution.execution_id);
      }
      store.db.query("UPDATE command_resources SET phase='removed' WHERE execution_id=?").run(execution.execution_id);
    }
  };
}
