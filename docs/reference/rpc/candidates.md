# Review Candidate

本节管固定 commit 的验收：`candidate.*`。

| CLI | RPC | 参数 |
|---|---|---|
| `lush candidate list [--input ID]` | `candidate.list` | `{input?}` |
| `lush candidate inspect ID` | `candidate.inspect` | `{id}` |
| `lush candidate prepare INPUT [--summary '…']` | `candidate.prepare` | `{input, summary?}` |
| `lush candidate verify ID` | `candidate.verify` | `{id}` |
| `lush candidate accept ID` | `candidate.accept` | `{id}` |
| `lush candidate changes ID '反馈'` | `candidate.changes` | `{id, feedback}` |
| `lush candidate reject ID [--reason '…']` | `candidate.reject` | `{id, reason?}` |

除 `candidate.list` / `candidate.inspect` 外全部是**用户专属**（USER_ONLY）；Web 的 `POST /api/action` 白名单同样放行这五条。

## 语义

`candidate.prepare` 要求该 Intent 没有活动工作、没有 failed worker、私有 integration branch 没有未收拢子分支，并把它与其他工作聚合完成。runtime 只固定 integration commit 与 target baseline commit，创建状态为 `pending` 的新版 `review_candidates`（旧版本 `pending`/`preparing`/`ready`/`accepted` 会被标 `superseded`），**不会自动派验收任务**。

只有用户显式调用 `candidate.verify`（Web 的“开始验收”）才会派只读 verifier。verifier 在固定 integration commit 与固定 baseline commit 上运行同一验收场景，把自包含 HTML 报告写到 `.lush/verify/<verifier-id>/report.html`，通过 `GET /api/task/<id>/report` 打开。结算时 Candidate 必须仍为 `preparing`，且 `report_task_id` 必须仍指向该 verifier；满足时报告成功进入 `ready`，报告缺失或任务失败进入 `failed`。用户已经拒绝、要求修改、用新版替代或登记更新 verifier 时，迟到结果保留在 Task / Run / Artifact / 报告与 `candidate.verification_ignored` 事件中，但不再改变 Candidate。当前实现不主动取消已经运行的 verifier。

`candidate.accept` 会再次校验当前 branch tip 仍等于被审阅 commit；不等时报错并要求生成新版本，绝不夹带未审阅内容。校验通过后，固定 commit 会一路传到 Git 串行边界；目标分支只会 fast-forward 到该提交，或确认已经包含它，Candidate 才进入 `integrated`。

`candidate.changes` 把该版本标为 `changes_requested` 并**在同一个 Intent 下**创建增量 planner，反馈作为消息投递给它；旧版本与旧 commit 保持不变。`candidate.reject` 放弃该版本，历史保留。

状态：

```text
pending → preparing → ready → accepted → integrated
preparing / ready → changes_requested → 新版本
preparing / ready → rejected
当前 verifier 失败 → failed → preparing（candidate.verify 重试）
pending / preparing / ready / accepted → superseded
迟到 verifier → 结果留痕，Candidate 状态不变
```
