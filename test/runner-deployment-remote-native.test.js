import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RunnerClient } from '../src/runner/client.js';
import { OFFICIAL_BUN } from '../src/core/runner-deployment-official.js';
import { uploadedProductionFixture, observeHostDelegation } from './runner-deployment-remote-native-fixture.js';

const official_zip = process.env.LUSH_TEST_OFFICIAL_BUN_ZIP;
// Explicit opt-in, no guessed cache location/download/pin substitution. The test
// proves a real negative boundary, NOT production command/stop readiness.
test.skipIf(!official_zip)('official bytes uploaded and extracted -> real managed shell/Bun/uploaded production entry and attach fail closed; no fabricated recovery baseline', async () => {
  const host = observeHostDelegation(); console.info(JSON.stringify({ uploaded_production_host_observation: host }));
  const f = await uploadedProductionFixture({ official_zip });
  try {
    expect(f.probe.abi.status).toBe('ready'); expect(f.probe.remote.abi_observed_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(f.runtime).toMatchObject({ ok: true, stage: 'runtime', sha256: OFFICIAL_BUN.sha256, size: OFFICIAL_BUN.size });
    expect(f.runner).toMatchObject({ ok: true, stage: 'runner', sha256: f.bundle.runner.sha256, size: f.bundle.runner.size });
    expect(f.snapshot.bun).toBe(OFFICIAL_BUN.sha256);
    expect(f.bundle.files).toContain('src/runner/index.js'); expect(f.bundle.files).toContain('src/runner/command-guard.js'); expect(f.bundle.files).toContain('src/runner/command-child.js');
    const stages = path.join(f.managed.install_root, 'stages'); expect(fs.existsSync(path.join(stages, 'runtime.done'))).toBe(true); expect(fs.existsSync(path.join(stages, 'runner.done'))).toBe(true);
    const host_preflight = await f.probeHostDelegation();
    if (!host.kill_writable) expect(host_preflight).toEqual({ code: 'UNSUPPORTED' });
    // Production managed guards, with test-only admission/error observers,
    // refuse the unavailable delegation.
    // Actual RunnerClient hello never obtains an authenticated response.
    await expect(f.verify()).rejects.toThrow('Runner installation verification was not confirmed');
    expect(f.sessions[0].methods).toEqual(['hello']); expect(f.sessions[0].responses).toEqual([]); expect(f.sessions[0].exit.code).not.toBe(0); expect(f.sessions[0].unsupported).toBe(false);
    expect(fs.existsSync(f.marker)).toBe(true); expect(f.sessions[0].events.some(e => e.phase === 'hello' || e.phase === 'verified')).toBe(false);
    // Isolate the NEXT layer by adapting only the launcher's cgroup observation.
    // Uploaded runRunner/createRunnerNode, actual command-service preflight,
    // RunnerStore and protocol remain pristine: still no successful hello.
    await expect(f.verify({ observe_launcher_cgroup: true })).rejects.toThrow('Runner installation verification was not confirmed');
    expect(f.sessions[1].methods).toEqual(['hello']); expect(f.sessions[1].responses).toEqual([]); expect(f.sessions[1].exit.code).not.toBe(0); expect(f.sessions[1].unsupported).toBe(true);
    for (const session of f.sessions) { expect(session.events.map(e => e.phase)).toEqual(['connection', 'intent']); expect(session.events[1].method).toBe('hello'); expect(session.request_timeouts).toHaveLength(1); expect(session.request_timeouts[0]).toBeLessThanOrEqual(2000); }
    expect(await f.probeUploadedEntry()).toEqual({ ok: false, code: 'UNSUPPORTED' });
    const facts = f.facts(); expect(facts).toMatchObject({ workspaces: 0, commands: 0 }); expect(facts.runner_id).toMatch(/^[a-f0-9-]{36}$/);
    // Same uploaded official binary, dynamic production command-child and attach
    // implementation: an unavailable root must reject BEFORE payload execution.
    expect(f.probeUploadedAttach()).toEqual({ code: 126, signal: null, error: null, stdout: '', stderr: '', payload_ran: false });
    expect(f.facts()).toEqual(facts); expect(f.original()).toEqual(f.snapshot);
    // There is no legitimate original verification/seal here. Do NOT seed a fake
    // proof/runner_id or stopped execution just to make provisional launch pass.
    expect(fs.existsSync(path.join(f.managed.install_root, 'sealed'))).toBe(false);
    const recovery_id = randomUUID(); await expect(f.remote.recoveryCheck({ managed: f.managed, recovery_id })).rejects.toThrow('not confirmed');
    expect(fs.readdirSync(path.join(f.managed.install_root, 'recoveries'))).toEqual([]); expect(fs.readdirSync(path.join(f.managed.install_root, 'runtime-generations'))).toEqual([]);
    fs.unlinkSync(f.marker);
    const transport = f.transport({ provisional: { recovery_id, generation_sha256: 'b'.repeat(64) }, observe_launcher_cgroup: true });
    const identity = { node_id: f.managed.node_id, project_id: f.project_id, worker_id: 1, workspace_id: 'native-provisional-negative', generation: 1, operation_id: randomUUID() };
    const client = new RunnerClient({ transport, identity, auth: f.auth, expected_runner_id: facts.runner_id });
    try { await expect(client.handshake({ timeout_ms: 2000 })).rejects.toThrow(); } finally { await client.close(); }
    expect(fs.existsSync(f.marker)).toBe(false); // Real shell refused before FD9/Bun exec.
    expect(f.facts()).toEqual(facts); expect(fs.readFileSync(path.join(f.managed.install_root, 'recovery-gate'), 'utf8')).toBe('none\n');
    expect(fs.readdirSync(path.join(f.managed.install_root, 'recoveries'))).toEqual([]); expect(f.original()).toEqual(f.snapshot);
    expect(transport.fixture_ssh_args).toContain('StdinNull=no'); expect(transport.fixture_ssh_args).toContain('StrictHostKeyChecking=yes');
    for (const secret of [f.auth.machine_token, f.auth.control_token]) expect(transport.fixture_ssh_args.join(' ')).not.toContain(secret);
    console.info(JSON.stringify({ uploaded_production_result: { runtime: 'verified-official-upload', runner: 'verified-production-upload', native_exec: true,
      host_preflight: host_preflight.code, production_entry: 'UNSUPPORTED', production_attach_exit: 126, authenticated_hello: false, workspaces: facts.workspaces, commands: facts.commands,
      original_seal: false, provisional: 'blocked-before-bun', production_command_stop_chain: 'NOT_VALIDATED' } }));
  } finally { await f.close(); }
});
