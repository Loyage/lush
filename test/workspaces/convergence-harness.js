import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../../src/config.js';
import { Store } from '../../src/persistence/store.js';
import { Workspaces } from '../../src/core/workspaces.js';
import { methods as objects } from '../../src/core/workspaces/delivery-objects.js';
import { methods as publish } from '../../src/core/workspaces/delivery-publish.js';
import { methods as validation } from '../../src/core/workspaces/delivery-validation.js';
import { temp, env, repo, git } from '../helpers.js';

export { git };
export async function setup({ checkedOut = true, initial = null } = {}) {
  const root = temp(), config = new Config({ project: root, env: env() }); config.prepare();
  const store = new Store(path.join(config.home, 'project.db'), root);
  const workspaces = new Workspaces(config, store); Object.assign(workspaces, objects, publish, validation);
  try {
    await repo(root);
    if (initial) {
      for (const [name, text] of Object.entries(initial)) fs.writeFileSync(path.join(root, name), text);
      await git(root, 'add', '.'); await git(root, 'commit', '-m', 'fixture base');
    }
    const baseline = await git(root, 'rev-parse', 'HEAD');
    const parent = store.create({ role: 'agent', task_kind: 'main', goal: 'main' });
    store.update(parent.id, { branch: 'main', workspace: checkedOut ? root : null, status: 'waiting' });
    store.recordBranch({ branch: 'main', task_id: parent.id, worktree: checkedOut ? root : null, created_from_commit: baseline });
    if (!checkedOut) await git(root, 'checkout', '-b', 'unrelated', baseline);
    const f = { root, config, store, workspaces, baseline, parent, members: [],
      async member(name, changes = {}, base = baseline) {
        const task = store.create({ role: 'agent', task_kind: 'child', goal: name, name, parent_id: parent.id });
        await workspaces.exclusive(() => workspaces.forkTaskUnsafe(task, 'main', base));
        const live = store.task(task.id);
        const member = { task_id: task.id, delivery_id: task.id, enqueue_seq: task.id,
          source_branch: live.branch, source_commit: base, base_commit: base, workspace: live.workspace };
        if (Object.keys(changes).length) await f.change(member, changes);
        store.update(task.id, { head_commit: member.source_commit, status: 'awaiting_acceptance', integration: 'pending' });
        f.members.push(member); return member;
      },
      async change(member, changes) {
        for (const [name, text] of Object.entries(changes)) {
          const file = path.join(member.workspace, name);
          if (text === null) fs.unlinkSync(file);
          else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
        }
        await git(member.workspace, 'add', '.'); await git(member.workspace, 'commit', '-m', 'source changes');
        member.source_commit = await git(member.workspace, 'rev-parse', 'HEAD');
        store.update(member.task_id, { head_commit: member.source_commit });
        return member.source_commit;
      },
      async combine(members = f.members, base = baseline) {
        const leaves = [];
        for (const member of members) leaves.push(await workspaces.mergeConvergenceObjects({ base: member.base_commit,
          left: base, right: member.source_commit, parents: [base], message: 'normalized leaf' }));
        let root = leaves[0];
        for (const leaf of leaves.slice(1)) root = await workspaces.mergeConvergenceObjects({ base,
          left: root.commit, right: leaf.commit, message: 'combine' });
        return root;
      },
      async prepare(tree, { members = f.members, base = baseline, run_id = 1, generation = 1, commit = null, evidence = null } = {}) {
        return workspaces.exclusive(() => workspaces.prepareConvergencePublishUnsafe({ parent: 'main', baseline: base,
          tree, members, run_id, generation, commit, evidence, message: 'fixed batch' }));
      },
      apply(receipt, guard = () => true) { return workspaces.exclusive(() => workspaces.applyConvergencePublishUnsafe(receipt, guard)); },
      settle(receipt) {
        // The fixed parent now supplies the real Store schema and transactional member APIs.
        // Exercise them instead of maintaining a parallel test-only SQL table/receipt shape.
        store.transaction(() => {
          const run = store.createDeliveryRun({ parent_id: parent.id, target_branch: receipt.parent,
            baseline: receipt.baseline, validation: null, data: {}, members: receipt.members.map(member => ({
              task_id: member.task_id, delivery_id: member.delivery_id, enqueue_seq: member.delivery_id,
              source_branch: member.branch, source_commit: member.source, base_commit: receipt.baseline,
            })) });
          if (run.id !== receipt.run_id || run.generation !== receipt.generation) throw new Error('fixture receipt/run identity mismatch');
          store.updateDeliveryRun(run.id, { state: 'integrated', candidate_commit: receipt.commit,
            candidate_tree: receipt.tree, landing_receipt: receipt }, run.generation);
          for (const member of receipt.members) {
            store.update(member.task_id, { integration: 'merged', head_commit: member.source });
            store.event(member.task_id, 'task.merge_integrated', { convergence: true, run_id: receipt.run_id,
              generation: receipt.generation, parent_id: parent.id, delivery_id: member.delivery_id,
              source_commit: member.source, commit: receipt.commit, tree: receipt.tree });
          }
          store.releaseDeliveryMembers(run.id);
        });
      },
      close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); },
    };
    return f;
  } catch (error) { store.close(); fs.rmSync(root, { recursive: true, force: true }); throw error; }
}
