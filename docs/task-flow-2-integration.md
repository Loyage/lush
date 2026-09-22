# 私有集成与 Review Candidate

本章解释并行工作如何在不触碰用户目标分支的前提下收敛，以及何时产生可以开始验收的固定候选。

> 连续阅读：[流程总览](task-flow.md) → [提交与规划](task-flow-1-planning.md) → **集成与候选** → [验收与回收](task-flow-3-delivery.md)

## 自动中间集成

Plan 编译出的工作完成后，Integration Service 在**私有 Intent 分支内部**自动收敛：

```text
最深 code 下游 → 上游任务分支 → Intent 集成分支
```

并行 sibling 与集成分支分歧时，runtime 自动创建 child-side merger：把冻结的父 commit 合入子侧、解决冲突并测试，再逐层 fast-forward。**目标分支始终不动。**

## Review Candidate

内部工作全部收敛后，runtime：

1. 固定 Intent 集成分支的精确 commit；
2. 固定目标分支的 baseline commit；
3. 创建一版状态为 `pending` 的 Review Candidate，但不自动验收；
4. 用户显式执行 `lush candidate verify ID`（保留的 CLI / RPC 底层检验；Web 主入口已改为[效果展示](showcase.md)）后，派只读 verifier 在两边运行同一验收场景；
5. 把自包含 HTML 报告写到 `.lush/verify/<verifier-id>/report.html`，并在同目录提交 version 1 `evidence.json`；
6. runtime 校验证据并绑定固定 commit；只有没有 `failures` / `unverified` 的 `pass` 且报告存在时 Candidate 进入 `ready`（允许披露 `baseline_failures` / `residual_risks`）；其它结论进入 `failed`，正常返回但没证据是 `unverified`。

查看：

```bash
lush candidate list --input 1
lush candidate verify 2                  # 用户显式启动验收
lush candidate inspect 2
lush task inspect <report_task_id>       # 报告路径与结论
```

Web 的 Intent 工作台把候选版本、状态与「打开结果」直接画在目标行上。

---

[← 上一篇：提交与规划](task-flow-1-planning.md) · [下一篇：验收与回收 →](task-flow-3-delivery.md)
