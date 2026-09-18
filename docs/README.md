# 文档

Lush 0.2 从电脑级 AI 管家改为项目级开发应用，是一次不兼容重构。

- [使用说明](../README.md)：运行、任务、worktree 与合并。
- [总体架构](engineering/architecture.md)：模块、不变量、调度与恢复。
- [CLI / RPC 参考](reference/api.md)：当前公开接口。
- `log/`：0.1 的历史开发记录，涉及 Service / SID / 全局 home 的内容均已失效，不应作为当前实现规范。

## 重构映射

| 旧模型 | 新模型 |
|---|---|
| 全局 Lush root → project-manager → project | 项目目录绑定的单个 Project runtime |
| Service 的模板、变量、持久状态 | 移除；Task 自己持有目标、角色、上下文与工作区 |
| Service 上单个活动 task | 无 Service；直接按 task 调度，受并发额度限制 |
| 唯一 SID 0 解析任务与交棒 | 每条 Input 对应独立 planner，规划槽与执行槽分开 |
| worktree-service 的 agent 自行管理 Git 生命周期 | runtime 统一创建 worktree、校验提交、执行用户批准的合并 |
| 全局 `$LUSH_HOME` | 固定 `<project>/.lush/`，路径哈希区分 socket |
| Agent profile / mock / openai / pi | 先收敛到 pi / mock，项目启动时选择 |
| 服务树为主的界面 | 用户输入、任务树、任务结果、待决问题与待合并代码 |

没有旧数据库自动迁移，也没有兼容的 `service.*` RPC。旧 `.lush/` 应在停止旧 daemon 后整体移开保存。
