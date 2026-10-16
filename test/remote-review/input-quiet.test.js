import { test, expect } from 'bun:test';
import { runnerProjectFixture, command } from '../project/runner-delivery-harness.js';

// Desired invariant is already enforced for local cancelled dirty workspaces.
test('exclusive input must not treat cancelled remote dirty work as reclaimed/quiet', async () => {
  const f = await runnerProjectFixture();
  f.project.kick = () => {};
  try {
    const worker = await f.worker();
    await command(worker.client, 'printf unaccepted > unaccepted.txt');
    const state = await f.project.workspaces.inspectRemoteWorkspace({ ...worker.options, require_no_lease: true });
    expect(state.clean).toBe(false);
    f.project.cancel(worker.id);
    await Promise.allSettled([...(f.project.runnerStopJobs ?? [])]);
    expect(f.store.task(worker.id).status).toBe('cancelled');
    const included = f.project.inputProjectWork().some(row => row.id === worker.id);
    const clean = await f.project.inputWorkspaceClean(f.store.task(worker.id));
    const emitted = await f.project.emitBufferedInput({ content: 'exclusive after remote cancellation',
      runner_node_id: 'local', exclusive: true });
    f.project.stopping = false;
    await f.project.drainInputEmissions();
    f.project.stopping = true;
    const dispatch = f.project.inputEmissionResult(emitted.draft_id).dispatch;
    console.log('review remote quiet projection:', JSON.stringify({ included, clean, dispatch }));
    expect(dispatch.state).toBe('waiting_conditions');
    expect(dispatch.worker_id).toBeUndefined();
  } finally { f.project.stopping = true; await f.close(); }
});
