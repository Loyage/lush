# 贡献指南

本层面向维护 Lush 源码与文档的开发者。

- [文档写作约定](documentation.md)：格式、层级、链接、流程图和自动检查。
- [本地读取性能报告](read-performance.md)：重复采样、环境身份、JSON 输出与既有预算；不等同于真实 RPC / 浏览器验收。
- [模块地图](../engineering/modules.md)：源码与测试的职责边界及导出契约。
- [生命周期不变量](../engineering/invariants.md)：修改 runtime 前必须保持的规则。

## 分层测试与交付

开发阶段必须验证本次改动，不要求每个 Worker、每次提交都跑全量：

- 子 Worker 默认运行新增／修改功能的专项与受影响模块、调用链回归；中间子 Worker 汇总后补跨子成果集成验证，不在每层重复全量。
- 派工目标必须写明改动与验证范围、最终全量负责的指令 Worker；再派工传递同一责任。影响广泛（如 Git、持久化、权限、调度、公共接口／架构）或范围无法判断时说明原因并扩大验证，必要时提前全量；用户明确要求的范围必须遵守。
- 直接交付 main/owner 的顶层开发指令 Worker（无子 Worker 时也一样）收齐成果并完成自身修改后，在自己的 worktree 验证跨模块集成与最终全量，再交付 main/owner。不在每次子成果落地后重复全量，不等进入 main 后才修复。
- 源侧固定父基线修复必须审查增量、适配语义并跑受影响回归；child 不因此默认全量，顶层指令最终代码树变化后须重新全量。
- 只读回答、纯文档改动运行目标所需检查，不空跑全量。所选测试必须实际跑完；中断不算通过。交付列出命令、范围、结果、未覆盖风险，未跑全量时说明原因与负责 Worker。

```bash
bun run test 路径...     # 子 Worker 的专项／受影响回归
bun run docs:check      # 修改文档时
bun run test            # 顶层开发指令交付前的全量 Web/core 套件；只需 Bun / Git
```

已有全量通过结果仅在被测代码树（含测试）、命令／范围及关键环境一致，且证据完整可追溯时复用；仅 Squash 改变提交号不要求重测，无法确认一致则不得复用。代码／测试变化后不得沿用旧树的通过结论。全量失败先定位并修复本次回归、重跑失败专项，最终再完整跑全量；区分既有失败与环境问题，不扩大为无关修复，也不得把仍失败的全量报成通过。

这是 Agent 的验证约定，内置规则位于 `src/agent/prompts.js`；当前合并 runtime 没有自动全量测试门禁或缓存，自动验收和 CI 不代替顶层指令的验证责任。

`bun run test:all` 与默认测试运行同一完整套件；`bun run test:serial 路径...` 用于聚焦串行诊断。无路径忽略模式或打包专项。真实浏览器脚本使用系统浏览器，质量 CI 执行测试与文档检查。

## CI 触发方式

- `.github/workflows/quality.yml`：推送到 `main`、PR 和合并队列时自动运行 Ubuntu / Bun 1.4.2 的全量测试与文档检查，也可手动触发。
- `.github/workflows/code-reader-posix.yml`：仅手动触发代码读取器的跨平台专项，不再随 push / PR 自动运行；保留 Linux/macOS × Bun 1.2.0/1.4.2 四组合。需要验证时，在 GitHub 的 Actions 中选择 **Code reader POSIX safety → Run workflow**，再选择待测分支。

精简测试与 fixture 的边界见[测试模块地图](../engineering/modules-interfaces.md#测试test)。
