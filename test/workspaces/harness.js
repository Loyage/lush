import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';

// 本分区共享的准备工作：每个用例自己调用一次，拿到独立的 fixture / store / project。
// 不保留任何模块级可变状态，所以多个测试文件并发跑也不会互相影响。
export async function setup() {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  // planner 只写 spec 队列（spawn 会拒绝 planner 父任务），这里直接造一个能派活的 coordinator。
  const parent = f.store.create({ input_id: null, role: 'coordinator', goal: 'build' });
  const task = f.project.spawn(parent.id,'implement','worker',[],'implement-feature');
  return { ...f, task };
}

export async function change(f, task, content = 'changed\n', filename = 'file.txt') {
  const cwd = await f.project.workspaces.ensure(task);
  fs.writeFileSync(path.join(cwd, filename), content);
  await git(cwd,'add',filename); await git(cwd,'commit','-m','implementation');
  await f.project.workspaces.finish(f.store.task(task.id));
  f.store.update(task.id,{status:'completed'});
  return cwd;
}
