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

`candidate.prepare` 要求该 Intent 没有活动工作、没有 failed worker、私有 integration branch 没有未收拢子分支，并把它与其他工作聚合完成。runtime 固定 integration commit 与 target baseline commit，创建新版 `review_candidates`（旧版本 `ready`/`accepted` 会被标 `superseded`），然后派只读 verifier。

verifier 在固定 integration commit 与固定 baseline commit 上运行同一验收场景，把自包含 HTML 报告写到 `.lush/verify/<verifier-id>/report.html`，通过 `GET /api/task/<id>/report` 打开。报告成功后 Candidate 进入 `ready`。

`candidate.accept` 会再次校验当前 branch tip 仍等于被审阅 commit；不等时报错并要求生成新版本，绝不夹带未审阅内容。校验通过后按 direct-parent / ff-only 规则合入 target branch，Candidate 进入 `integrated`。

`candidate.changes` 把该版本标为 `changes_requested` 并**在同一个 Intent 下**创建增量 planner，反馈作为消息投递给它；旧版本与旧 commit 保持不变。`candidate.reject` 放弃该版本，历史保留。

状态：

```text
preparing → ready → accepted → integrated
               └→ changes_requested → 新版本
               └→ rejected
preparing / ready / accepted → superseded
verifier 失败 → failed（可 candidate.verify 重试）
```
