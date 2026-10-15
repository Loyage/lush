import fs from 'node:fs';
import path from 'node:path';
import { setup } from './harness.js';
import { repo, git, gate } from '../helpers.js';
import { projectRouteId } from '../../src/host/registry.js';
import { saveProjectAppearance } from '../../src/host/project-appearance.js';

/** Isolated authenticated Host/RPC/Git with a controlled Agent and a real final fixture suite. */
export async function oneShotIntegrationFixture({ hold = false, count = 2 } = {}) {
  const f = await setup();
  const kick = f.project.kick.bind(f.project), merge = f.project.scheduleTaskMerge.bind(f.project), converge = f.project.scheduleConvergence.bind(f.project);
  f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {}; f.project.scheduleConvergence = () => {};
  const entered = gate(), release = gate(); let calls = 0;
  try {
    await repo(f.root); const parent = await f.project.bootstrapMain();
    saveProjectAppearance(f.root, { initialize: true }, { env: f.config.env });
    fs.writeFileSync(path.join(f.root, 'verify.test.js'), `import {test,expect} from 'bun:test'; import fs from 'node:fs';\nfor(let i=0;i<${count};i++) test('combined source '+i,()=>expect(fs.readFileSync('source-'+i+'.txt','utf8')).toBe('source '+i+'\\n'));\n`);
    await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'final combination fixture checks');
    const sources = [];
    for (let i = 0; i < count; i++) {
      const source = (await f.project.order(`来源 ${i} · 独立需求`, 'main')).task;
      fs.writeFileSync(path.join(source.workspace, `source-${i}.txt`), `source ${i}\n`);
      await git(source.workspace, 'add', '.'); await git(source.workspace, 'commit', '-m', `source ${i}`);
      await f.project.workspaces.finish(f.store.task(source.id));
      f.store.update(source.id, { status: 'waiting', result: '受控来源，最终组合专项由整合 Worker 执行。', reservation: null });
      sources.push(f.store.task(source.id));
    }
    f.project.provider = { run: async ({ task, cwd, context }) => {
      calls++; entered.resolve(task.id); if (hold) await release.promise;
      for (const member of context.integration.members) await git(cwd, 'merge', '--no-edit', member.source_commit);
      const proc = Bun.spawn([process.execPath, 'test', '--timeout=20000'], { cwd, env: f.config.env, stdout: 'pipe', stderr: 'pipe' });
      const [out, error, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (code) throw Error(`fixture final suite failed: ${out}\n${error}`);
      return `最终组合验证：bun test --timeout=20000，${count} 项通过。受控 Provider 不证明真实模型整合质量。`;
    } };
    return { ...f, parent, sources, projectId: projectRouteId(f.root), baseline: await git(f.root, 'rev-parse', 'main'),
      entered, release, get providerCalls() { return calls; },
      start() { f.project.kick = kick; f.project.scheduleTaskMerge = merge; f.project.scheduleConvergence = converge; kick(); },
      async close() { release.resolve(); await f.close(); } };
  } catch (error) { release.resolve(); await f.close(); throw error; }
}
