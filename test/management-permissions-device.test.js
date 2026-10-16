import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, fixture } from './helpers.js';
import { acquireConfigurationLock } from '../src/core/device-config.js';
import { readDeviceManagementPermissions as read, saveDeviceManagementPermissions as save } from '../src/core/management-permissions.js';
import { managementPermissionMethods } from '../src/rpc/management-policy.js';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { assertAllowed } from '../src/rpc/registry.js';
import { RUNNER_METHODS } from '../src/rpc/runner-methods.js';

const fileAt = config => path.join(config.deviceHome, 'management-permissions.json');
function device() {
  const root = temp(), config = { deviceHome: path.join(root, 'shared') };
  return { root, config, close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
test('ordinary Agent and Valet cannot directly read or mutate permission settings, even with device scope', () => {
  for (const method of ['management.permissions','management.permissions_update']) {
    for (const actor of [8,9]) expect(() => assertAllowed(method, {}, actor)).toThrow('requires user approval');
    expect(() => assertAllowed(method, { scope: 'device' }, null)).toThrow('unknown parameter');
  }
});

test('daemon recovery owns a bounded policy monitor and shutdown clears it without creating shared policy', async () => {
  const f = fixture();
  try {
    f.project.kick = () => {};
    f.project.recover();
    expect(f.project.managementPermissionsMonitor).toBeTruthy();
    expect(read(f.config).configured).toBe(false);
    expect(fs.existsSync(fileAt(f.config))).toBe(false);
    await f.project.shutdown(); expect(f.project.managementPermissionsMonitor).toBeNull();
  } finally { await f.close(); }
});

const source = new URL('../src/core/management-permissions.js', import.meta.url).pathname;
async function processSave(config, permissions, revision) {
  const script = `import { saveDeviceManagementPermissions as save } from ${JSON.stringify(source)};
    try { console.log(JSON.stringify({ ok: true, result: save(${JSON.stringify(config)}, ${JSON.stringify(permissions)}, ${JSON.stringify(revision)}) })); }
    catch (error) { console.log(JSON.stringify({ ok: false, error: error.message })); }`;
  const process = Bun.spawn([Bun.which('bun'), '--eval', script], { stdout: 'pipe', stderr: 'pipe' });
  const [output, errors, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  expect(exit).toBe(0); expect(errors).toBe(''); return JSON.parse(output);
}

test('missing device policy is a read-only reviewed draft, first explicit save is private and complete', () => {
  const f = device();
  try {
    const draft = read(f.config);
    expect(draft).toMatchObject({ version: 1, scope: 'device', configured: false });
    expect(fs.existsSync(f.config.deviceHome)).toBe(false);
    expect(draft.methods).toHaveLength(managementPermissionMethods().length);
    expect(draft.permissions).toEqual(Object.fromEntries(draft.methods.map(item => [item.method, item.base_access])));
    const saved = save(f.config, draft.permissions, draft.revision);
    expect(saved.configured).toBe(true); expect(saved.revision).not.toBe(draft.revision);
    expect(read(f.config)).toEqual(saved);
    expect(fs.statSync(f.config.deviceHome).mode & 0o777).toBe(0o700);
    expect(fs.statSync(fileAt(f.config)).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(f.config.deviceHome)).toEqual(['management-permissions.json']);
    expect(() => save(f.config, draft.permissions, draft.revision)).toThrow('revision changed');
  } finally { f.close(); }
});

test('complete mapping, review ceilings, non-disableable discovery and revisions cannot be bypassed', () => {
  const f = device();
  try {
    const draft = read(f.config), missing = { ...draft.permissions }; delete missing['draft.add'];
    for (const permissions of [null, [], {}, missing, { ...draft.permissions, unknown: 'read' },
      { ...draft.permissions, 'worker.accept': 'automatic' }, { ...draft.permissions, 'manager.catalog': 'unavailable' },
      { ...draft.permissions, 'management.permissions_update': 'confirmation' }, { ...draft.permissions, 'management.permissions': 'read' }])
      expect(() => save(f.config, permissions, draft.revision)).toThrow();
    for (const revision of [undefined, null, '', 'stale']) expect(() => save(f.config, draft.permissions, revision)).toThrow();
    expect(read(f.config).configured).toBe(false);
  } finally { f.close(); }
});

test('all user-only Runner methods including deployment/recovery stay unavailable when reading an older shared policy', () => {
  const f = device(), methods = Object.keys(RUNNER_METHODS);
  try {
    const draft = read(f.config); save(f.config, draft.permissions, draft.revision);
    const file = fileAt(f.config), previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const method of methods) delete previous.permissions[method];
    fs.writeFileSync(file, JSON.stringify(previous));
    const current = read(f.config);
    for (const method of methods) {
      expect(current.permissions[method]).toBe('unavailable');
      expect(current.methods.find(item => item.method === method).allowed_access).toEqual(['unavailable']);
      for (const access of ['read', 'automatic', 'confirmation'])
        expect(() => save(f.config, { ...current.permissions, [method]: access }, current.revision)).toThrow('elevated');
    }
    expect(save(f.config, current.permissions, current.revision).permissions).toEqual(current.permissions);
  } finally { f.close(); }
});

test('two project policies remain separate until explicit save; historical rows and snapshots never become device authority', async () => {
  const d = device(), a = fixture(undefined, { LUSH_GLOBAL_CONFIG: d.root }), b = fixture(undefined, { LUSH_GLOBAL_CONFIG: d.root });
  try {
    for (const [f, access] of [[a,'unavailable'],[b,'confirmation']]) {
      const old = f.project.managementPermissions();
      f.project.setManagementPermissions({ ...old.permissions, 'draft.add': access }, old.revision);
    }
    const rows = [a,b].map(f => f.store.get("SELECT value FROM meta WHERE key='management_permissions'").value);
    expect(a.project.managementPermissions()).toMatchObject({ scope: 'project', permissions: { 'draft.add': 'unavailable' } });
    expect(b.project.managementPermissions()).toMatchObject({ scope: 'project', permissions: { 'draft.add': 'confirmation' } });
    // Opening the global draft neither imports a project's values nor switches either authority.
    const draft = read(a.config); expect(draft.permissions['draft.add']).toBe('automatic'); expect(draft.configured).toBe(false);
    const rpc = new Dispatcher(a.project);
    await expect(rpc.dispatch('management.permissions_update', { permissions: draft.permissions, expected_revision: draft.revision })).rejects.toThrow('/api/host/management/permissions');
    expect(read(a.config).configured).toBe(false);
    const saved = save(a.config, { ...draft.permissions, 'draft.add': 'confirmation' }, draft.revision);
    expect(a.project.managementPermissions()).toEqual(saved); expect(b.project.managementPermissionsSnapshot()).toMatchObject({ scope: 'device', revision: saved.revision });
    expect(await rpc.dispatch('management.permissions', {})).toEqual(saved);
    await expect(rpc.dispatch('management.permissions_update', { permissions: draft.permissions, expected_revision: saved.revision })).rejects.toThrow('/api/host/management/permissions');
    expect(() => b.project.setManagementPermissions(draft.permissions, saved.revision)).toThrow('historical');
    expect([a,b].map(f => f.store.get("SELECT value FROM meta WHERE key='management_permissions'").value)).toEqual(rows);
  } finally { await a.close(); await b.close(); d.close(); }
});

test('independent processes serialize revision publication and share settings-write admission', async () => {
  const f = device();
  try {
    const draft = read(f.config);
    const replies = await Promise.all([processSave(f.config, { ...draft.permissions, 'draft.add': 'unavailable' }, draft.revision),
      processSave(f.config, { ...draft.permissions, 'draft.add': 'confirmation' }, draft.revision)]);
    expect(replies.filter(item => item.ok)).toHaveLength(1);
    expect(replies.filter(item => !item.ok)).toHaveLength(1);
    const current = read(f.config), lock = acquireConfigurationLock(f.config, 'device');
    try {
      const blocked = await processSave(f.config, draft.permissions, current.revision);
      expect(blocked).toMatchObject({ ok: false }); expect(blocked.error).toContain('busy');
      expect(read(f.config)).toEqual(current);
    } finally { lock.release(); }
    expect((await processSave(f.config, draft.permissions, current.revision)).ok).toBe(true);
  } finally { f.close(); }
});

for (const unsafe of ['symlink','hardlink','public','oversize','invalid','fifo']) test(`shared policy rejects ${unsafe} files without fallback, overwrite, or leaking source`, async () => {
  const f = device();
  try {
    const draft = read(f.config); save(f.config, draft.permissions, draft.revision);
    const file = fileAt(f.config), original = fs.readFileSync(file), target = path.join(f.root, 'PRIVATE-CONTENT');
    if (unsafe === 'symlink') { fs.renameSync(file, target); fs.symlinkSync(target, file); }
    if (unsafe === 'hardlink') fs.linkSync(file, target);
    if (unsafe === 'public') fs.chmodSync(file, 0o644);
    if (unsafe === 'oversize') fs.writeFileSync(file, 'PRIVATE-CONTENT'.repeat(30000));
    if (unsafe === 'invalid') fs.writeFileSync(file, '{PRIVATE-CONTENT');
    if (unsafe === 'fifo') { fs.unlinkSync(file); const proc = Bun.spawn(['mkfifo', '-m', '600', file]); expect(await proc.exited).toBe(0); }
    const stat = fs.lstatSync(file);
    expect(() => read(f.config)).toThrow('cannot be safely read');
    expect(() => save(f.config, draft.permissions, draft.revision)).toThrow('cannot be safely read');
    expect(fs.lstatSync(file).ino).toBe(stat.ino);
    if (unsafe === 'symlink' || unsafe === 'hardlink') expect(fs.readFileSync(target)).toEqual(original);
  } finally { f.close(); }
});

for (const unsafe of ['public','alias']) test(`unsafe ${unsafe} device root is not repaired or followed`, () => {
  const f = device();
  try {
    const draft = read(f.config); fs.mkdirSync(f.config.deviceHome, { mode: 0o700 });
    if (unsafe === 'public') fs.chmodSync(f.config.deviceHome, 0o755);
    if (unsafe === 'alias') { const target = path.join(f.root, 'target'); fs.renameSync(f.config.deviceHome, target); fs.symlinkSync(target, f.config.deviceHome); }
    expect(() => read(f.config)).toThrow('cannot be safely read');
    expect(() => save(f.config, draft.permissions, draft.revision)).toThrow('unsafe');
  } finally { f.close(); }
});
