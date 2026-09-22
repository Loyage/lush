# 恢复可靠测试基线与持续集成

本条面向测试与开发流程维护者，目标是让全量测试稳定反映当前接口契约，而不是仅增加用例数量。主要入口是 `test/helpers.js`、`test/web/`、`test/project/questionnaire.test.js` 与 `test/integration/questionnaire.test.js`。

## 状态与优先级

- 优先级：P1，与 P0 修复的回归测试并行推进。
- 状态：待处理。
- 审查基线：`bun run test` 得到 448 通过、8 失败，共 456 个测试、93 个文件。
- 文档检查通过；不能据此推断功能测试通过。

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

## 建议方向

- 修复测试前提、异步契约与 teardown，保证每个文件独立运行且组合运行一致。
- 保持现有轻量 DOM 测试，另补少量真实浏览器主流程测试。
- 浏览器测试建议覆盖输入提交、问卷回答、Candidate 验收、接受交付。
- 仓库内未看到 GitHub Actions 配置；根据实际托管平台确认 CI 方案。
- CI 至少运行 `bun run test` 和 `bun run docs:check`，再按支持范围选择 macOS / Linux 与 Bun 版本矩阵。
- 浏览器测试工具及依赖安装方式在实施前确认，遵循项目的 Nix 环境约定。

## 验收标准

- [ ] 全量测试通过，修复前后的数量变化有说明。
- [ ] 原失败文件单独运行与组合运行均通过。
- [ ] 状态清理不依赖其它测试先执行。
- [ ] Candidate 两项一致性问题有确定性回归用例。
- [ ] CI 失败阻止合并，或提供等效的仓库质量门禁。
- [ ] 测试仅使用临时项目和可控子进程，结束后清理资源。

[返回待办索引](README.md)
