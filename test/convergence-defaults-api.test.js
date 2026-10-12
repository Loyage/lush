import { test, expect } from 'bun:test';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { run as branch } from '../src/cli/commands/branch.js';
const revision = 'read-revision';
const cli = (args, client) => branch('branch', ['convergence', ...args], { client, json: true });

test('defaults RPC requires strict booleans and opaque revision before runtime calls', async () => {
  const calls = [], d = new Dispatcher({ actor: () => null, setBranchConvergenceDefaults(...args) { calls.push(args); } });
  const valid = { mounted: true, enabled: true, expected_revision: revision };
  for (const flag of [undefined, null, 'true', 1, [], {}]) {
    await expect(d.dispatch('branch.convergence_defaults_set', { ...valid, mounted: flag })).rejects.toThrow('mounted');
    await expect(d.dispatch('branch.convergence_defaults_set', { ...valid, enabled: flag })).rejects.toThrow('enabled');
  }
  for (const expected_revision of [undefined, null, 1, '', [], {}, ' padded ', 'bad\nrevision', 'x'.repeat(257)])
    await expect(d.dispatch('branch.convergence_defaults_set', { ...valid, expected_revision })).rejects.toThrow('revision');
  expect(calls).toEqual([]);
  for (const [mounted, enabled] of [[false,false],[false,true],[true,false],[true,true]])
    await d.dispatch('branch.convergence_defaults_set', { mounted, enabled, expected_revision: revision });
  expect(calls).toEqual([[false,false,revision],[false,true,revision],[true,false,revision],[true,true,revision]]);
});

test('CLI on omits validation, remove preserves metadata by omission, mount retains existing enabled and off retains mount', async () => {
  const calls = [], current = { branch: 'main', revision, mounted: false, enabled: false, validation: null };
  const client = { request(method, params) { calls.push({ method, params }); return method === 'branch.convergence' ? current : { ok: true }; } };
  await cli(['on','main','--revision',revision], client);
  await cli(['remove','main','--revision',revision], client);
  await cli(['off','main','--revision',revision], client);
  current.mounted = true; current.enabled = true;
  await cli(['mount','main','--revision',revision], client);
  expect(calls).toEqual([
    { method: 'branch.convergence_set', params: { branch: 'main', enabled: true, expected_revision: revision } },
    { method: 'branch.convergence_set', params: { branch: 'main', mounted: false, enabled: false, expected_revision: revision } },
    { method: 'branch.convergence', params: { branch: 'main' } },
    { method: 'branch.convergence_set', params: { branch: 'main', mounted: false, enabled: false, validation: null, expected_revision: revision } },
    { method: 'branch.convergence', params: { branch: 'main' } },
    { method: 'branch.convergence_set', params: { branch: 'main', mounted: true, enabled: true, expected_revision: revision } },
  ]);
});

test('CLI defaults rejects missing, duplicate and foreign options and can retain enabled while unmounted', async () => {
  const calls = [], client = { request(method, params) { calls.push({ method, params }); } };
  const valid = ['defaults','set','--mounted','true','--enabled','true','--revision',revision];
  for (const args of [['defaults'], ['defaults','unknown'], ['defaults','show','main'], ['defaults','show','--revision',revision],
    ['defaults','set'], ['defaults','set','--revision',revision], ['defaults','set','--mounted','false','--revision',revision],
    ['defaults','set','--mounted','yes','--enabled','false','--revision',revision], [...valid,'--enabled','false'], [...valid,'--mounted','false'],
    [...valid,'--revision',revision], [...valid,'--command','old'], [...valid,'main'], ['remove','main'], ['mount','main','--revision',revision,'--version','1']])
    await expect(cli(args, client)).rejects.toThrow();
  expect(calls).toEqual([]);
  await cli(['defaults','show'], client); await cli(valid, client);
  await cli(['defaults','set','--mounted','false','--enabled','true','--revision',revision], client);
  expect(calls).toEqual([{ method: 'branch.convergence_defaults', params: undefined },
    { method: 'branch.convergence_defaults_set', params: { mounted: true, enabled: true, expected_revision: revision } },
    { method: 'branch.convergence_defaults_set', params: { mounted: false, enabled: true, expected_revision: revision } }]);
});
