# Lush 开发约定

Lush 是**项目级的多 agent 开发应用**。Bun / JavaScript / SQLite，零第三方运行时依赖。

## 作用域

- 一个 daemon 对应一个 canonical 项目目录，状态固定在 `<project>/.lush/`。
- 默认向上发现 `.lush/project.json` 或 `.git`；用 `--project PATH` 显式选择项目。
- `LUSH_PROJECT` 会传入 agent 子进程，agent 在独立 worktree 中仍连接原项目。
- `LUSH_HOME` 不再允许指向独立的全局目录；非空时必须等于 `<project>/.lush`。
- 没有 Service、SID、project-manager 或模板模型。不要重新引入电脑级调度。

## 命令一律走 bun run

```bash
bun run doctor                  # 首先确认项目 / home / daemon 的代码身份
bun run test
bun run start                   # 只启动所选项目；已有 daemon 不会换版本
bun run daemon-restart          # 运行代码、提示词或配置变更后重启
bun run say '输入'              # 立即返回，不等开发完成
bun run tree
bun run inspect 3
bun run web                     # 只启动本地 Web，不操作 daemon
bun run stop
```

任意入口可加 `--project PATH`；操作其他项目时必须显式指定。`bun run lush <command>` 也遵循同一套项目发现规则，没有旧版默认全局 home 的例外。

不要在开发测试时默认操纵用户正在开发的项目。测试用临时项目目录和 mock/可控子进程；测试结束停 daemon 并清理自己的临时文件。

## 安全与持久化

- Git 操作通过 `src/core/workspaces.js`，无 shell 插值，所有 Lush Git 变更串行。
- 每个 worker 独立 worktree / 分支；默认必须由用户明确批准合并。
- 不强制 reset / clean / 删除工作区，不自动提交用户已有改动。失败工作区也有价值。
- `completed` 不等于 `merged`。保留独立的任务状态与 integration 状态。
- Task 的父子关系创建后不变；终态 task 不允许活动后代。
- Agent 等待子任务或用户时释放 invocation 槽；新输入有独立规划槽。
- 消息只在 invocation 之间送达。注意「父任务刚 park、子任务刚完成、running Map 还未清理」之间的 lost-wakeup 竞态。
- 重启不自动重放有未知副作用的调用；旧 Service 数据不迁移、不覆盖。

## 模块

- `src/config.js`：项目发现与不可变绑定。
- `src/persistence/store.js`：SQLite 事实来源。
- `src/core/project.js`：任务树、消息、notice、调度与生命周期。
- `src/core/workspaces.js`：Git 工作区、人工批准合并、安全清理。
- `src/agent/`：共享指令、pi 与 mock 后端。
- `src/rpc/` / `src/daemon/`：通信、装配、锁与退出。
- `src/ui/client.js`：CLI / Web 的统一客户端。
- `src/cli/` / `src/ui/web/`：用户界面。

`src/identity.js` 的 fingerprint 覆盖整个 src、bin 和 package.json。相同路径但 fingerprint 不同表示 daemon 仍运行旧代码；重启正确项目才生效。

更多见 `README.md` 与 `docs/README.md`。`docs/log/` 是重构前历史，不代表当前 API。
