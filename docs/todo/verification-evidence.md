# 结构化验收证据

本条面向验收流程与结果读模型维护者，目标是让用户区分“验收任务执行完了”和“改动已经验证通过”。入口为 `src/core/project/scheduling.js`、`src/core/project/verify.js`、`src/core/project/lifecycle.js` 与 `src/persistence/store/runs.js`。

## 状态与优先级

- 优先级：P1。
- 状态：已实施。
- 完成范围：扩展现有 Artifact payload 与 Candidate 读模型；未新增业务实体、数据库表或列，也未重写旧记录。

## 已实施契约

- 新 `run.result` 使用 `schema_version: 2`，`invocation.status` 单独表示 provider 正常返回，`verification.status` 严格限定为 `pass` / `fail` / `partial` / `unverified`。
- verifier 在 runtime 给定的 `evidence_path` 写 version 1 JSON。runtime 校验版本、枚举、文本/数组/文件大小、命令与退出码；格式错误使 invocation 失败，不包装成成功结论。
- runtime 自己绑定 tested commit、baseline commit 与报告引用，不信任 agent 自述的 commit/path。证据同时保存命令、两边退出码、摘要、失败项、未验证项、基准失败和残余风险。
- HTML 报告仍是人类阅读入口；只有报告存在且结构化结论为 `pass` 时 Candidate 才进入 `ready`。正常返回但没有证据是 `unverified`，`fail` / `partial` / `unverified` 都不会放行。
- Artifact 仍存入原 `artifacts.payload` JSON 文本列。旧 `run.result` 原样留在磁盘，读模型补出 `verification.status: unknown`；旧 Candidate 或没有验收任务的 Candidate 同样显示 `unknown`。
- `candidate.accept` 仍是唯一交付入口；自动验收最多改变 Candidate 的待人工审阅状态，不会触发目标分支合并。

## 验收标准

- [x] 用户能区分执行完成、验证通过、验证失败和未验证。
- [x] 每份证据明确绑定被测提交与基准，不能被分支后续推进替代。
- [x] 仅有报告文件不再被展示成“测试通过”的充分依据。
- [x] 失败或不完整证据不会被统一包装成成功结论。
- [x] 旧 Artifact 和旧 Candidate 仍可读，缺少证据时明确显示未知。
- [x] 补齐通过、失败、部分验证、无报告和基准失败场景的测试。

## 实施证据

- `test/project/verification-evidence.test.js` 覆盖 pass / fail / partial / unverified、报告缺失、基准失败、旧 Artifact 与非法 payload。
- `test/project/candidates.test.js` 覆盖固定 commit/baseline 的读模型与人工接受。
- `test/integration/candidate.test.js` 覆盖真实 provider 脚本写报告和 evidence、Candidate ready 后再由用户接受交付。

[返回待办索引](README.md)
