# 贡献指南

本层面向维护 Lush 源码与文档的开发者。

- [文档写作约定](documentation.md)：格式、层级、链接、流程图和自动检查。
- [本地读取性能报告](read-performance.md)：重复采样、环境身份、JSON 输出与既有预算；不等同于真实 RPC / 浏览器验收。
- [模块地图](../engineering/modules.md)：长期职责与必要契约入口，精确导出见源码。
- [生命周期不变量](../engineering/invariants.md)：修改 runtime 前必须保持的规则。

## 分层测试与交付

开发阶段必须验证本次改动，不要求每个 Worker、每次提交都跑全量：

- 子 Worker 默认运行新增／修改功能的专项与受影响模块、调用链回归；中间子 Worker 汇总后补跨子成果集成验证，不在每层重复全量。
- 派工前确认公共接口、生命周期与已交付依赖，先提交经验证的可运行共享骨架；父页面等模块实际合入后再接线，不提前引用未交付文件或伪造兄弟模块。详细流程集中在 `src/agent/skills/lush-delegation/guide.md`。
- 派工目标必须区分 child 可独立验证的范围与收齐后的集成范围，分别明确负责人，并写明最终全量负责的指令 Worker；受依赖阻塞的测试记录原因与补验负责人，不冒充通过。再派工传递同一责任。影响广泛（如 Git、持久化、权限、调度、公共接口／架构）或范围无法判断时说明原因并扩大验证，必要时提前全量；用户明确要求的范围必须遵守。
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

### 全量前快速集成检查

按改动类型显式选择既有回归组合，可一次传入多个类型：

```bash
bun run test:integration page
bun run test:integration rpc component
bun run test:integration page rpc component
bun run test:integration --list                # 只读 JSON：全部类型、去重路径与实际命令
bun run test:integration --list page component # 只列出指定组合，不执行测试
```

- `page`：导航／深链接、启动及懒加载资源图、编译后的根／项目页面启动、冷启动 JS 模块数与阻塞 CSS 预算。
- `rpc`：注册表／处理器一致性、权限默认拒绝与调用身份、HTTP 参数／项目转接、登录／Origin 和公共返回值过滤；管理工具以可控 Node/Bun CLI 验证真实 Provider／扩展激活／bridge／RPC 执行返回。
- `component`：模块入口导出与构建图兼容、离页请求取消及迟到响应保护、返回时节点／输入／阅读与折叠状态恢复。

组合集中维护在 `scripts/test-integration.js`，只引用已有测试；更新组合前核对文件内实际断言，精确路径以 `--list` 为准。多类型按输入顺序合并，类型与路径去重后只调用一次现有 `bun run test`，沿用默认四进程并发与 20 秒单项预算。未知类型／选项、未选择类型、缺失或非文件路径均报错并非零退出；测试退出码原样传递，不自动重试或忽略失败。

此入口不猜测 Git 变更、不增加 runtime 门禁，也不代替专项或最终全量。它覆盖的是所列回归，不保证所有功能、真实浏览器表现或实际 Pi CLI／模型行为；新增能力仍须专项验证其自身“入口 → 注册 → 权限 → 执行 → 返回结果”真实链路，不能只靠 mock。收齐成果后的集成与最终全量责任仍按上面的分层约定执行。

### 测试超时预算

`package.json` 的 test／test:all／test:serial 统一 `--timeout=20000`：全量（默认四进程）、专项、串行和 CI 均为 **20 秒单项默认预算**，不自动重试／跳过，不改产品超时、fixture 等待或性能断言。Bun 1.4.2 忽略 bunfig 的 test.timeout，因此用 CLI 参数；不要先用原生 5 秒预算跑全量再临时加时。

已有单项设置／setDefaultTimeout 保持；诊断可用 `bun run test:serial 路径 --timeout 5000`，追加参数覆盖入口默认值。仍超时须保留完整日志，定位慢步骤、资源释放或等待条件，不无限加预算或反复全量碰运气。

## CI 触发方式

- `.github/workflows/quality.yml`：推送到 `main`、PR 和合并队列时自动运行 Ubuntu / Bun 1.4.2 的全量测试与文档检查，也可手动触发。
- `.github/workflows/code-reader-posix.yml`：仅手动触发代码读取器的跨平台专项，不再随 push / PR 自动运行；保留 Linux/macOS × Bun 1.2.0/1.4.2 四组合。需要验证时，在 GitHub 的 Actions 中选择 **Code reader POSIX safety → Run workflow**，再选择待测分支。

精简测试与 fixture 的边界见[测试模块地图](../engineering/modules-interfaces.md#测试test)。
