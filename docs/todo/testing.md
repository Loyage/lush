# 恢复可靠测试基线与持续集成

本条面向测试与开发流程维护者，目标是让全量测试稳定反映当前接口契约，而不是仅增加用例数量。主要入口是 `test/helpers.js`、`test/web/`、`test/project/questionnaire.test.js` 与 `test/integration/questionnaire.test.js`。

## 状态与优先级

- 优先级：P1，与 P0 修复的回归测试并行推进。
- 状态：已完成。
- 修复前基线：`bun run test` 得到 448 通过、8 失败，共 456 个测试、93 个文件。
- 修复后基线：`bun run test` 得到 459 通过、0 失败，共 459 个测试、93 个文件；`bun run docs:check` 检查 54 个 Markdown 文件并通过。

## 已观察到的失败

### 问卷运行时与集成测试

`test/project/questionnaire.test.js` 有 3 个失败，`test/integration/questionnaire.test.js` 有 1 个失败。

日志显示测试没有准备提交输入所需的 Git 仓库；部分用例仍以 `f.project.submit(...).task` 同步读取现已异步返回的结果，触发 `task` 为 undefined。

应更新 fixture 与调用方式，不应放宽生产代码的 Git 输入边界来迁就旧测试。

### UI 测试隔离

全量运行时：

- `test/web/dom-navigation.test.js` 的 2 个用例失败。
- `test/web/dom-studio.test.js` 的 1 个用例失败。

分别单文件运行后，上述用例全部通过。这是跨测试状态污染或执行顺序依赖的证据，尚未完成具体污染源定位；应优先检查全局 DOM、模块缓存与 `navigate.js` 的导航注册单例。

### 问卷忽略动作

`test/web/dom-questionnaire.test.js` 的忽略问卷用例，单独运行仍失败：预期 dismissal 回调执行一次，实际为零。

需要区分确认弹窗 stub、异步等待和真实动作逻辑的问题，不能仅凭此断言浏览器功能损坏。

## 实施结果

- 问卷 project / integration fixture 先创建临时 Git 仓库，并按异步契约等待 `submit()`。
- 问卷忽略动作改用应用内确认框；DOM 用例显式确认后再断言回调。
- `registerNavigation()` 返回带身份保护的 teardown，临时导航 handler 不再污染其它测试文件。
- Candidate 增加确定性交错测试：固定提交校验与落地位于同一 Git 串行区间；迟到 verifier 不能覆盖 `rejected`、`changes_requested`、`superseded` 或不再绑定自己的候选。
- `.github/workflows/quality.yml` 在 pull request、`main` push 与 merge queue 上运行 Bun 1.4.2 的全量测试和文档检查。
- GitHub `main` 已启用必需状态检查 `Bun tests and docs`（包含管理员，不强制 PR 审核）。

## 验收标准

- [x] 全量测试通过，修复前后的数量变化有说明。
- [x] 原失败文件单独运行与组合运行均通过。
- [x] 状态清理不依赖其它测试先执行。
- [x] Candidate 两项一致性问题有确定性回归用例。
- [x] CI 失败阻止合并，或提供等效的仓库质量门禁。
- [x] 测试仅使用临时项目和可控子进程，结束后清理资源。

[返回待办索引](README.md)
