# 统一用户流程、文档与版本诊断

本条面向产品体验、文档和进程运维入口的维护者，目标是降低用户理解交付流程与判断运行版本的成本。涉及根 README、专题文档、Web 工作台和 doctor / web-status 入口。

## 状态与优先级

- 优先级：P2；事实性文档纠错可以先行。
- 状态：已完成。
- 依据：根 README 与流程专题已统一交付口径；`doctor` / `web-status` 的结构化身份诊断及集成测试已经落地。

## 文档口径冲突

根 `README.md` 在本轮审查时同时包含以下说法：

- 开头写“每一步都由用户明确批准”，后文又说明私有 Intent 内自动集成。
- Candidate 专节写创建候选不自动派 verifier，需要显式验收。
- 新模型概述及部分 `candidate prepare` 命令注释又暗示创建候选会生成报告。

应以当前实现为依据区分私有集成、验收启动和最终接受，不应为统一文字而擅自改变运行行为。

## 用户认知建议

普通用户主流程建议突出：

```text
目标 → 执行 → 待决定 → 待验收 → 已落地
```

分支谱系、兼容交付入口与详细 Git 状态继续保留，但作为高级诊断，不要求用户先掌握全部内部实体才能完成一次交付。

建议将根 README 收敛为快速开始、关键边界和文档入口，细节放在已有专题中。实际页面层级和术语调整属于 UX 决策，实施前确认。

## 运行版本诊断

本次 `bun run doctor` 返回 `code_match: false`。这只证明当时 daemon 与磁盘源码不同，不说明 Web 进程版本，也不应被写成永久存在的问题。

建议：

- 集中展示当前代码、daemon 和 Web 的身份与版本一致性。
- 提供针对正确项目和进程的明确更新提示。
- 保持 daemon 与 Web 独立诊断，避免把 daemon 正常误当成 Web 已更新。
- 不因发现版本差异就自动重启，避免打断活动 invocation 或清空 Web 登录会话。

## 验收标准

- [x] 文档对私有自动集成、显式验收和最终人工接受的描述一致。
- [x] `candidate prepare` 的示例不再暗示必然生成验收报告。
- [x] 主流程能明确区分任务完成、候选待验收与代码已落地。
- [x] README 的详细规则通过链接指向权威专题，减少重复维护。
- [x] 版本提示能分别识别 daemon 与 Web，不静默替用户重启。
- [x] `bun run docs:check` 通过；涉及 UI 或命令改动时补对应测试。

## 完成证据

- `README.md` 与 `docs/task-flow.md` 明列 `Task completed → Candidate pending/ready → Candidate integrated`，并链接权威的集成、验收与 Candidate API 专题。
- `src/cli/commands/system.js` 保留旧 `fingerprint` / `code_match` 字段，同时新增 `identities`、`current_code` / `daemon_code` / `web_code` 与作用域明确的 `update_hint(s)`；诊断路径只读，不调用 restart。
- `test/integration/daemon.test.js` 覆盖 doctor 的磁盘 / daemon / Web 分离身份；`test/integration/web.test.js` 覆盖 Web 身份、旧指纹提示、正确项目与端口命令，以及诊断不换进程。
- `bun run test`：469 项通过；`bun run docs:check`：54 个 Markdown 文件通过。

[返回待办索引](README.md)
