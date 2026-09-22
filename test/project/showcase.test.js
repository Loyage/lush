import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { fetch } from '../web/harness.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { Project } from '../../src/core/project.js';
import { builtInPrompt, AGENT_ROLES } from '../../src/agent/prompts.js';

const page = context => fs.writeFileSync(context.showcase.report_path, '<!doctype html><title>效果展示</title><h1>真实前后对照</h1>');
const serve = [process.execPath, '-e', `Bun.serve({hostname:process.env.HOST,port:Number(process.env.PORT),fetch:()=>Response.json({preview:process.env.LUSH_PREVIEW,token:process.env.LUSH_AGENT_TOKEN??null,project:process.env.LUSH_PROJECT??null})});`];
const ended = f => until(() => !f.project.running.size && !f.store.activeTasks().length, 8000);

async function feature(f) {
  await repo(f.root);
  const base = await git(f.root, 'rev-parse', 'HEAD');
  await git(f.root, 'checkout', '-b', 'feature');
  fs.writeFileSync(path.join(f.root, 'file.txt'), 'changed\n');
  await git(f.root, 'commit', '-am', 'feature');
  const commit = await git(f.root, 'rev-parse', 'HEAD');
  await git(f.root, 'checkout', 'main');
  return { base, commit };
}

test('showcase pins arbitrary local branches, requires unknown baseline, and never owns the source ref', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    const { base, commit } = await feature(f);
    fs.writeFileSync(path.join(f.root, 'file.txt'), 'user unsaved work\n');
    await expect(f.project.startShowcase('feature')).rejects.toThrow('baseline');
    await expect(f.project.startShowcase('feature~1', 'main')).rejects.toThrow();
    await expect(f.project.startShowcase(commit, 'main')).rejects.toThrow();
    await expect(f.project.startShowcase('feature', '--all')).rejects.toThrow();
    const first = await f.project.startShowcase('feature', 'main');
    expect(first.role).toBe('showcase'); expect(first.parent_id).toBeNull(); expect(first.branch).toBeNull();
    expect(first.showcase.commit).toBe(commit); expect(first.showcase.baseline_commit).toBe(base);
    await expect(f.project.startShowcase('feature', 'main')).rejects.toThrow('still active');
    await git(f.root, 'update-ref', 'refs/heads/feature', base, commit);
    const cwd = await f.project.workspaces.ensure(f.store.task(first.id));
    expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(commit);
    expect(await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8')).toBe('user unsaved work\n');
    const node = (await f.project.graph()).nodes.find(row => row.kind === 'task' && row.id === first.id);
    expect(node.branch).toBe('feature'); expect(node.head_commit).toBe(commit); expect(node.branch_state).toBeNull();
    expect(node.merged).toBeNull(); expect(node.target_branch).toBeNull();
    f.project.cancel(first.id);
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'unexpected edit');
    await expect(f.project.workspaces.cleanup(first.id)).rejects.toThrow();
    expect(fs.readFileSync(path.join(cwd, 'file.txt'), 'utf8')).toBe('unexpected edit');
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'changed\n');
    await git(cwd, 'checkout', '-b', 'showcase-test-local');
    await expect(f.project.workspaces.cleanup(first.id)).rejects.toThrow('detached');
    await git(cwd, 'checkout', '--detach', commit);
    await f.project.workspaces.cleanup(first.id);
    expect(await git(f.root, 'rev-parse', 'refs/heads/feature')).toBe(base);
    expect(f.store.task(first.id).workspace).toBeNull();
    f.store.recordBranch({ branch: 'feature', parent: 'main', created_from_commit: base });
    const second = await f.project.startShowcase('feature');
    expect(second.showcase.baseline_commit).toBe(base);
    expect(f.project.showcases('feature').map(row => row.id)).toEqual([second.id, first.id]);
    expect(f.project.showcases('missing')).toEqual([]);
  } finally { await f.close(); }
});

test('dedicated showcase invocation delivers HTML and artifact, never a verification pass or merge', async () => {
  let seen;
  const f = fixture({ async run(args) { seen = args; page(args.context); return '展示已就绪'; } });
  try {
    const { commit } = await feature(f);
    const task = await f.project.startShowcase('feature', 'main');
    await ended(f);
    expect(seen.task.role).toBe('showcase'); expect(seen.context.showcase.commit).toBe(commit);
    expect(seen.context.verification).toBeUndefined();
    expect(seen.cwd).not.toBe(f.root);
    const result = f.project.inspect(task.id);
    expect(result.status).toBe('completed'); expect(result.integration).toBe('none'); expect(result.branch).toBeNull();
    expect(result.report).toContain(`/showcase/${task.id}/report.html`);
    expect(result.artifacts.find(row => row.kind === 'showcase.result').payload.commit).toBe(commit);
    expect(result.artifacts.find(row => row.kind === 'run.result').payload.verification.status).toBe('unverified');
    expect(f.store.candidates()).toEqual([]);
    expect(await git(f.root, 'show', 'HEAD:file.txt')).toBe('base');
    expect(f.store.all("SELECT * FROM notices WHERE task_id=? AND kind='info'", task.id)).toHaveLength(1);
    expect(AGENT_ROLES).toContain('showcase');
    expect(builtInPrompt('showcase')).toContain('不是验收员');
    expect(builtInPrompt('showcase')).toContain('先在 report_path 建立最低可用的自包含报告');
    expect(builtInPrompt('showcase')).toContain('localhost URL 纯文本是允许的');
    expect(f.project.agentConfig().options.roles.some(role => role.value === 'showcase' || role.id === 'showcase')).toBe(true);
  } finally { await f.close(); }
});

test('no HTML cannot masquerade as delivered showcase, retries preserve but cannot reuse an older report', async () => {
  let attempts = 0;
  const f = fixture({ async run({ context }) { if (++attempts === 1) { page(context); throw new Error('interrupted after writing'); } return 'no report'; } });
  try {
    await feature(f);
    const task = await f.project.startShowcase('feature', 'main'); await ended(f);
    expect(f.store.task(task.id).status).toBe('failed'); expect(f.project.hasReport(task.id)).toBe(true);
    const pinned = f.project.inspect(task.id).showcase.commit;
    await git(f.root, 'update-ref', 'refs/heads/feature', await git(f.root, 'rev-parse', 'main'));
    f.project.retry(task.id); await ended(f);
    expect(f.store.task(task.id).status).toBe('failed');
    expect(f.store.task(task.id).error).toContain('must deliver report.html');
    expect(f.project.hasReport(task.id)).toBe(false);
    expect(f.project.inspect(task.id).showcase.commit).toBe(pinned);
    expect(fs.readdirSync(path.dirname(f.project.reportPath(task.id))).some(name => name.startsWith('report-before-run-'))).toBe(true);
  } finally { await f.close(); }
});

test('preview remains live after completion, strips credentials, blocks cleanup, and stops without touching source', async () => {
  const f = fixture({ async run({ api, task, context }) {
    const preview = await api.startShowcasePreview(task.id, serve);
    expect((await (await fetch(preview.url)).json())).toEqual({ preview: '1', token: null, project: null });
    page(context); return 'preview ready';
  } });
  try {
    const { commit } = await feature(f);
    const task = await f.project.startShowcase('feature', 'main'); await ended(f);
    expect(f.store.task(task.id).error).toBeNull();
    expect(f.store.task(task.id).status).toBe('completed');
    const preview = f.project.inspect(task.id).showcase.preview;
    expect(preview.status).toBe('running'); expect((await fetch(preview.url)).ok).toBe(true);
    await expect(f.project.workspaces.cleanup(task.id)).rejects.toThrow('stop the showcase preview');
    await f.project.stopShowcasePreview(task.id);
    expect(f.project.inspect(task.id).showcase.preview.status).toBe('stopped');
    await expect(fetch(preview.url)).rejects.toThrow();
    await f.project.workspaces.cleanup(task.id);
    expect(await git(f.root, 'rev-parse', 'feature')).toBe(commit);
    expect(f.project.hasReport(task.id)).toBe(true);
  } finally { await f.close(); }
});

test('failed/cancelled showcases stop previews; normal daemon shutdown stops completed previews and recovery never replays', async () => {
  let fail = true;
  const f = fixture({ async run({ api, task, context }) {
    await api.startShowcasePreview(task.id, serve); page(context);
    if (fail) throw new Error('demo failure');
    return 'ready';
  } });
  try {
    await feature(f);
    const task = await f.project.startShowcase('feature', 'main'); await ended(f);
    expect(f.store.task(task.id).status).toBe('failed');
    await until(() => f.project.inspect(task.id).showcase.preview.status === 'stopped');
    fail = false;
    f.project.retry(task.id); await ended(f);
    expect(f.store.task(task.id).error).toBeNull();
    const url = f.project.inspect(task.id).showcase.preview.url;
    const baseline = f.store.task(task.id).baseline_workspace;
    await f.project.shutdown();
    await expect(fetch(url)).rejects.toThrow();
    const restored = new Project(f.config, f.store, { async run() { throw new Error('must not replay'); } });
    restored.recover();
    expect(restored.inspect(task.id).showcase.preview).toEqual({ status: 'stopped', url: null });
    expect(fs.existsSync(baseline)).toBe(true); // no forced verifier baseline cleanup
    expect(restored.inspect(task.id).status).toBe('completed');
    await restored.shutdown();
  } finally { await f.close(); }
});

test('cancellation interrupts a starting preview and releases its subprocess before cleanup', async () => {
  const started = gate();
  const f = fixture({ async run({ api, task }) {
    const pending = api.startShowcasePreview(task.id, [process.execPath, '-e', 'setInterval(()=>{},1000)']);
    started.resolve(); await pending; return 'not reached';
  } });
  try {
    await feature(f);
    const task = await f.project.startShowcase('feature', 'main'); await started.promise;
    f.project.cancel(task.id); await ended(f);
    expect(f.project.previewStarting.size).toBe(0);
    expect(f.store.task(task.id).status).toBe('cancelled');
    await f.project.workspaces.cleanup(task.id);
  } finally { await f.close(); }
});

test('RPC only lets the live showcase actor start its own preview and forbids agent showcase creation/delegation', async () => {
  const hold = gate(), started = gate(); let token;
  const f = fixture({ async run(args) { token = args.token; started.resolve(); await hold.promise; page(args.context); return 'done'; } });
  try {
    await feature(f);
    const rpc = new Dispatcher(f.project);
    const task = await rpc.dispatch('showcase.start', { branch: 'feature', baseline: 'main' });
    await started.promise;
    await expect(rpc.dispatch('showcase.start', { branch: 'feature', baseline: 'main', _token: token })).rejects.toThrow('user approval');
    await expect(rpc.dispatch('showcase.stop', { id: task.id, _token: token })).rejects.toThrow('user approval');
    await expect(rpc.dispatch('showcase.preview', { command: serve })).rejects.toThrow('agent only');
    await expect(rpc.dispatch('showcase.preview', { command: serve, id: task.id, _token: token })).rejects.toThrow('unknown parameter');
    await expect(rpc.dispatch('task.spawn', { goal: 'change source', _token: token })).rejects.toThrow('cannot delegate');
    await expect(rpc.dispatch('showcase.preview', { command: 'bun run dev', _token: token })).rejects.toThrow('argv array');
    await expect(rpc.dispatch('showcase.preview', { command: serve, path: '//example.com', _token: token })).rejects.toThrow('local URL path');
    const preview = await rpc.dispatch('showcase.preview', { command: serve, _token: token });
    expect(preview.url).toStartWith('http://127.0.0.1:');
    await expect(rpc.dispatch('showcase.preview', { command: serve, _token: token })).rejects.toThrow('existing preview');
    hold.resolve(); await ended(f);
    await expect(rpc.dispatch('showcase.preview', { command: serve, _token: token })).rejects.toThrow('expired');
  } finally { hold.resolve(); await f.close(); }
});
