import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';

// 本分区共享的准备工作：每个用例自己调用一次，拿到独立的 fixture / store / project。
// 不保留任何模块级可变状态，所以多个测试文件并发跑也不会互相影响。
export async function setup() {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  // 新模型：main 下一条 say Task 自己就拥有分支与 worktree；只有 say/child 能派活。
  const say = await f.project.say('implement');
  return { ...f, task: f.store.task(say.task.id), anchor: say.anchor };
}

export async function change(f, task, content = 'changed\n', filename = 'file.txt') {
  const cwd = await f.project.workspaces.ensure(task);
  fs.writeFileSync(path.join(cwd, filename), content);
  await git(cwd,'add',filename); await git(cwd,'commit','-m','implementation');
  await f.project.workspaces.finish(f.store.task(task.id));
  f.store.update(task.id,{status:'completed'});
  return cwd;
}
