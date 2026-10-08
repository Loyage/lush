# Web 端 Agent 配置与运行设置

本章说明浏览器端如何实现[项目 Agent 配置与双模式运行](agent-configuration-v2.md)的交互：谁掌握配置、模型目录怎么读、扩展与 Skills 怎么装、运行设置在哪里选。接口字段以主契约为准，这里只记前端职责、状态与失败边界。

## 双配置模式

`src/ui/web/assets/agent-config-mode.js` 是唯一语义来源：`CONFIG_MODES`（`lush` 默认 / `pi`）、`normalizeConfigMode`、`PI_MODE_HELP`、`profileForMode` 与 `MANAGED_SECTIONS`；`PI_THINKING_LEVELS` 供「模型来源」默认思考深度下拉使用，与后端 `settings.THINKING_LEVELS.pi` 同序。

- `lush`：摆出全部托管选项（来源、模型、思考深度、Prompt、扩展 / Skills、软预算、按 Worker 环境变量）。
- `pi`：隐藏并在提交时用 `profileForMode` 丢弃全部托管字段，只送 `{ agent: 'pi', config_mode: 'pi' }`；界面说明执行机器 Pi 自行管理认证、模型、资源与项目信任，Lush 仍提供任务指令、会话、消息与必需运行协议，且不自动批准未受信项目。
- 模式切换只影响托管字段；其他字段的未保存编辑保留。隔离的 `explainer` / `butler` 不得切到 Pi 模式。
- 后端 `normalize` 会再次清空托管字段，前端裁剪只是使界面与提交一致，不是安全边界。

## 三个入口

| 入口 | 文件 | 说明 |
|---|---|---|
| 项目默认与角色覆盖 | `render-settings.js` 的 `renderAgentSettings` / `profileEditor` | 每份 Profile 首位是配置模式；数据字段 `data-agent-field="config_mode"`。思考深度在目录确证该模型等级时收窄，未知时保留既有选项，不静默改写已保存等级。 |
| Worker 运行设置 / 重试 | `retry-dialog.js` 调用共享表单 `agent-profile-form.js` | 打开时自动读取本地连接列表和已选来源目录缓存，不联网、不自动替换来源或模型；慢响应或失败不阻断编辑，仍可手动重读且保留草稿。字段契约（`data-retry-field`）保持不变；Profile 只送 `worker.retry` / `worker.configure`，提交前按模式裁剪。 |
| 新建指令的运行设置 | `composer.js` 的 `openComposerRunSettings` | 只打开设置，不调用 Agent、不创建 Worker；确认后把 Profile 存在本会话，随下一次 `order.submit` 一起发送，创建成功后清空，不悄悄沿用到下一条指令。「恢复项目默认」只清除本条覆盖。 |

`agent-profile-form.js` 的 `createProfileForm({profile, settings, role, ownsPage, onChange, applyDefaultModelOnChange?})` 返回 `{node, ready, collect, validate, reset, mode, ...}`：`ready` 在资源目录与模型目录读取完成后 resolve，`collect()` 输出已按模式裁剪的 Profile，调用方决定提交目标。表单不自行发写请求。已选托管来源时提供「填入来源默认」：把该来源保存的 `default_model` / `default_thinking` 写入模型与思考深度两项（模型限定 `provider/model`），未读来源或无默认时只就地提示；不调用 Agent。Worker 的 `retry-dialog.js` 显式传入 `applyDefaultModelOnChange:true`，轻量入口也启用该选项；仅主动换源自动填入默认模型，不动思考深度，无默认保留并提示。项目/角色配置与新建指令不启用，具体边界见[切换来源](../design/agent-model-settings.md#切换来源)。

暂存只保存正文，不携带 Profile；从历史输入发射的 Worker 默认暂停，用户可在详情用「调整运行设置」补。轻量「切换模型来源」入口（`worker-model-source.js`）仍只发 `{connection_id, model}`；Worker 处于 Pi 模式时该入口禁用并用 `.help-host` 指向完整运行设置，绝不发送托管 `model_selection`。

## 模型目录

缓存、隔离与刷新边界见[托管来源的模型目录](agent-model-catalog.md)。`agent-connection-picker.js` 在用户选择来源后读取 `GET /api/agent/connections/models?id=…` 的**本地缓存目录**，不联网刷新、不调用模型、不查询额度。目录形状：

```js
{ version:1, id, checked_at, status:'fresh'|'cached'|'unknown'|'error'|'unsupported',
  source, models:[{ id:'provider/model', name, thinking_levels?, ... }], warning? }
```

- 只有 `fresh` / `cached` 的目录用于模型选项；`unknown` / `error` / `unsupported` 退回连接已保存的模型范围，并明确说明可以手填，不把失败当空。`connection.models` 是用户手动限制范围，展示时与目录取交集。
- 目录缺失或读取失败时 `thinkingLevels()` 返回 `null`，表单保留原思考深度选项，不伪造支持。
- 不从目录自动选中来源或模型；已有 Worker 主动换源的默认模型填入来自已读连接配置，不依赖目录成功或完整。其余模型不匹配时只提示，不替换。读取迟到且已离页时不得改写表单；未离页也不得覆盖换源后手动修改的模型。

## 扩展与 Skills

`render-settings.js` 的「已安装插件与 Skills」读 `GET /api/agent/packages`：

```js
{ version:1, packages:[{ id:'pkg-…', source, kind, installed, root, requested, version, resource_counts, ... }],
  resources:{ extensions:[{name,path,...}], skills:[{name,path,...}] }, truncated, warning?, action? }
```

- 安装 `agent.packages.install {source}`、移除 `agent.packages.remove {id}`、更新 `agent.packages.update {id}`；写操作走 `/api/action`，成功后重新读取列表。这些动作不调用 Agent，因此不带 `agent-call`。
- **安装与启用分离**：安装只写项目私有 Lush Pi 声明，不自动勾选任何 Profile 的扩展 / Skills。
- 前端在联网前先拒绝未固定来源（npm 需精确版本、git 需 commit/tag、或显式本地路径），后端仍会再校验；失败就地提示并保留输入，不冒充成功。
- 启用复选框使用 `resources[].path`，沿用 Profile 的 `extensions` / `skills`；已配置但当前未发现项标注保留。
- `/api/agent/packages` 不可用（旧 daemon / Host）时明确提示并退回只读的 `/api/agent/resources` 目录发现，安装 / 移除 / 更新禁用（禁用按钮由外层 `.help-host` 承载说明），不静默当空。

## 帮助、身份与失败保护

- 只有真正会启动 Agent 的按钮（创建、立即开始、重试、继续）带 `agent-call` 与 `agentHelp()`；打开运行设置、读取目录、安装、登录都不带。
- 禁用按钮的提示一律由外层 `.help-host` 承载；含义不直观的按钮带 `data-help`，不写 `title`。
- 所有读取与保存都按页面身份（`ui.view` / 页面对象）判断，离页或页面重画后的迟到响应不得改写表单、摘要或导航；保存不调用 Agent，不改变正在运行的调用。
- 输入框与草稿的“请求期间被改写不得清空”保护沿用[历史输入与缓冲区](../design/input-history.md)。

## 验证与未验证边界

自动测试在 `test/web/` 下用 DOM stub 与 mock fetch 覆盖：双模式切换与字段清除、Pi 模式只提交双字段、缺省 Lush 提交完整 Profile、目录命中 / 失败回退 / 不自动换来源、packages 安装 / 移除 / 更新与失败保留、旧 daemon 回退、窄入口 Pi 禁用、迟到响应与离页保护。测试不访问真实凭证、不联网安装、不调用模型。

真实模型目录接口、真实 npm / git 安装与第三方包运行环境由对应后端另行验收，不因前端测试通过而视为已验证。
