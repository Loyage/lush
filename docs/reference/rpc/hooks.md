# Hooks 与预约接口

用户流程见 [Worker Hooks 与预约发射](../../hooks.md)，完整定义与安全约束见 [Hooks 工程契约](../../engineering/hooks.md)。下列配置、挂载与预约写入口均为**用户专属**；Agent token 不得调用。

## RPC、HTTP 与 CLI

| RPC | 参数 | CLI（加 `bun run lush` 前缀） |
|---|---|---|
| `hooks.list` | `{}` | `hooks list` |
| `hooks.save` | `{template,expected_revision}` | `hooks save --file PATH --revision REV` |
| `hooks.remove` | `{id,expected_revision}` | `hooks remove TEMPLATE_ID --revision REV` |
| `worker.hooks` | `{id}` | `worker hooks ID` |
| `worker.hook_attach` | `{id,hook,expected_revision}` | `worker hook attach ID --file PATH --revision REV` |
| `worker.hook_update` | `{id,hook_id,enabled,expected_revision}` | `worker hook enable\|disable ID HOOK_ID --revision REV` |
| `worker.hook_remove` | `{id,hook_id,expected_revision}` | `worker hook remove ID HOOK_ID --revision REV` |

读取 HTTP：`GET /api/hooks`、`GET /api/worker/ID/hooks`，不接受查询参数。写入通过已登录、同源的 `POST /api/action {method,params}`，不是通用 RPC 代理。

目录返回 `{version:1,revision,triggers,actions,templates}`；Worker 返回 `{version:1,worker_id,revision,mounts}`。CLI 的 Worker 参数接受内部整数或 `Wn(-n)*`，先经 `worker.lookup` 解析；RPC/HTTP 的 `id` 与动作 `target_id` 仍是内部整数，不将 W 编号作为外键。消息动作的安全 `target_worker_number` 与创建收据的 `worker_number` 只是读标签，不回传到定义。

`revision` 是不透明字符串，必须先读并随写请求携带；过期返回错误，不覆盖并发修改。模板 `id` 与挂载 `hook_id` 是不同身份。

`hook` 可为新规则定义，或仅 `{template_id:'UUID'}`；后者让后台复制模板的完整私有覆盖。不得用脱敏列表重建原模板挂载。创建动作读取只有安全 `model_selection` 摘要；模板同位置创建动作省略 `profile` 表示编辑时保留原私有覆盖。

挂载含 `trigger`、`mode`、`enabled`、`conditions`、安全动作摘要、`state`、`last_execution`、`editable` 与 `removable`。`removable` 与可启用状态不同：结束的 Worker 可移除未来授权，不能重新启用。`id:'auto-merge'` 是不可移除的内置挂载；开关仍通过 `worker.auto_merge` 调整并复用原准入。

## JSON 规则示例

保存为当前用户独占的普通文件（例如 `chmod 600 hook.json`）；CLI 拒绝符号链接、其他所有者或宽权限文件，并限制 JSON 大小。

```json
{
  "name": "失败时通知",
  "trigger": "agent.failed",
  "mode": "persistent",
  "enabled": true,
  "actions": [{ "type": "notify", "title": "Worker 失败", "body": "请查看执行记录。" }]
}
```

模板编辑在定义中带 `id`，新建不带。可用节点、动作支持的触发器和模式以 `hooks.list` 为准；创建与消息动作只接受 `mode:'once'`。

## 预约指令与草稿

- `order.submit {content,branch?,references?,start?,profile?,defer:true}` 或 CLI `bun run lush order '指令' --defer [--branch BRANCH]`。
- 草稿：`order.submit {draft_id,expected_revision,start?,defer:true,profile?}`。只有显式预约才允许草稿附加运行覆盖；不得混入 content、references 或 branch。
- 父冻结时返回 `{deferred:true,parent_id,hook_id,hooks}`，**没有 `task`**，由父可创建安全点执行；父当前可写时仍直接创建，返回真实 `task`，显式覆盖同样生效。仅创建模式用 RPC `start:false` 或 Web 显式按钮。
- `input.parents.items` 包含有效的冻结父 Worker 和 `freeze`；只读候选不是最终创建许可。
- 草稿 `input.get` 返回 `hook_mount:{parent_id,hook_id,state}|null`；占用中的草稿拒绝编辑、删除和重复发射。

正常直接提交及草稿发射没有 `defer:true` 时行为不变；最终创建仍核验当前父身份、冻结、Git 与草稿版本。执行未知或明确失败不会因重启自动重试。
