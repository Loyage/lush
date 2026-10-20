# CLI 设计：围绕管家核心工作精简

本文说明 CLI 的保留原则，面向通过固定 `lush_cli` 管理项目的 Valet、通过 `lushw` 协作的开发 Worker 和维护者。W358／D731 确认：删除用户专属业务命令，保留启动诊断例外；管理业务只保留日常核心与自定义自动化。精确入口由 `src/cli/catalog.js` 与同源 CommandSpec 维护，迁移边界见[迁移依据](cli-migration.md)，公开契约见[CLI 与 RPC](../reference/api.md)。

## 核心取舍

CLI 不是 RPC 的完整镜像，也不以“后台存在接口”作为保留理由。主要消费者是受控 Valet：围绕提交、沟通、诊断、运行控制、交付及自动化形成少量完整流程，删除低频高级浏览、插件管理、私有材料、交互认证和历史维护入口。终端用户共用核心管理命令，不另养一套完整业务 CLI。

- `lush` 管当前项目的日常工作、模型来源与必要配置、自定义自动化，以及管家自身事务。保留 daemon／Host 启停、日志、doctor 和 help，供用户启动与诊断；这些例外不向 Valet 开放本地进程或文件权限。
- `lushw` 管 invocation 绑定的 self／parent／children 和本地 question／skills。开发协作不是管家管理，不能因为 Valet 用不到就删除，也不能借 `lush` 扩大开发 Agent 权限。
- 删除必须同时收敛命令注册、参数、处理器、帮助、工作流及调用方，不能只从帮助隐藏。旧拼写不执行替代操作，不保留可执行别名。
- 删除的是 CLI，不是底层能力、Web 页面或已有数据。后台 RPC、权限策略及历史兼容继续按各自契约工作；不引入通用 RPC／Shell 旁路。

## 按对象发现，按动作执行

管理命令按 worker、input、notice、branch、automation、agent、config、valet 分组；新建开发指令保留高频短入口 `order`。一个意图只有一个正式入口，目录不是第二个执行引擎。

- worker 是持久工作记录，不等于调用进程。W／V 通用查询与追加共用入口，Git、合并、开发验收仍按真实类型拒绝 V。
- input 管原话与未发送意图，worker message 管直接追加。draft 保存不授权；submit 授权可靠挂载，不承诺立即投递。
- automation 管定义，worker automation 管实际挂载。注册完成后独立挂载固定版本，不恢复“一步注册并安装”。
- config 管必要设备策略，agent 管安全模型来源与缓存。完整配置仅接受明确给出的数据，不从安全摘要补造未知私有设置。
- valet 仅保留安全上下文、收据与自身标题／进度／Notice；创建和急救由现有用户 Web／RPC 处理，不给管家自复制入口。

## 参数与安全流程一起精简

保留一种可用模式，而不是保留所有历史参数。管理业务结构化输入使用内联 `--data JSON`／`--questions-json JSON`，删除本地文件参数；`lushw` 本地问卷准备仍使用显式文件。秘密不得进入 argv，也不得为替代已删认证入口而新增明文凭证参数。

必要前置读取、目标解析、预检、revision、精确确认和收据查询随对应写操作一起保留。普通验收不提供用户强制模式；彻底删除仍先预检再精确确认。底层 Web／RPC 的强制验收与资源安全门不变。

参数严格校验未知项、重复单值、互斥模式和整数范围。`--` 后全部按正文处理；布尔配置用 on/off；Worker 使用真实 W／V 编号或整数，O／D／N 仅展示，不从内部 ID 推算编号。

## 关键工作流

### 提交与追加

```bash
bun run lush order '实现登录' --branch main
bun run lush worker message W5 '补充测试'
bun run lush input draft create '合并后继续' --append-to W5 --after-merged W6
bun run lush input draft show 17
bun run lush input draft submit 17 --revision 3
```

直接 message 与可靠条件发射不是等价协议。多个条件为 AND；cancel 撤销未执行授权，release 只释放独占。结果必须区分 saved、scheduled、delivered、unknown；响应未知时不自动另建或重发。

### 合并、自动化与验收

merge request 只提交本轮合并；条件 revision 来自 merge show，不与 automation show 的挂载 revision 混用。持久自动合并开关不等于本轮请求；启用 auto-merge 不得降低既有 accept 最高授权。branch merge-all 仍逐项走普通交付队列，不调用整合 Agent。

自定义自动化先登记，再以固定 template_id／template_version 独立挂载。登记、挂载、触发执行是三件不同的事。旧迁移、历史清理与持续归并不因保留自动化而恢复 CLI。

accept 必须核验真实交付、干净现场、消息、后代、冻结与资源回收；失败不报告成功。child 默认保留供追加需求，成果检查不等于立即验收。

### 决策与设备配置

Notice 明确区分 ask 与 notify。Worker 本地准备问卷后发布，Valet 使用内联问卷；发布决策后结束本轮，dismiss 不是同意。设备命令仍须显式范围和本轮用户授权，不把目录可见或配置默认值当授权。

模型来源 list/show 和模型目录 list 仅读缓存；refresh 显式联网，不探测付费模型。配置只影响后续调用，不自动继续、重试或热换当前 invocation。

## 单一来源与信息披露

CommandSpec 声明唯一命令 ID、路径、参数、RPC、身份、scope、读写分类、来源、前提、效果及恢复说明。parser、help、Web 学习页、Worker CLI 预检及 Valet 静态准入共用；dispatcher 仍是实时授权权威。不机械改名底层方法、权限键、数据库、事件或历史正文。

采用“短启动契约 → 分层 help → 按需 workflow → 可信执行反馈”，详见[能力发现](cli-agent-discovery.md)。帮助离线，不发现项目或读取私有权限；目录版本变化使相关静态知识失效，不重发写入。工作流只引用现存稳定命令 ID，不另养参数表。

JSON 使用 `{version:1,data,page?,outcome?,warnings?}`。真实编号、coverage、截断、原总数及实际续读游标不得丢失；正常返回不证明副作用完成，waiting／pending_confirmation／unknown 必须如实报告，不靠错误字符串推断未执行。

## 验证与发布

先验证可控 Provider → 固定 Valet bridge → 真实 CLI → 权限／执行 → 返回结果，再补 CLI 与 Worker 受影响专项。删除项应在发现、参数校验和执行三处一致拒绝，不新增泛型 RPC 入口来补齐目录。

复用已有 CLI、管家、Worker 与 Web 主流程，不为每个删除命令扩建测试矩阵。顶层指令 Worker 在最终代码树运行 `bun run test:integration cli rpc page`、`bun run test` 与 `bun run docs:check`，不以静态目录通过冒充真实链路验证。

同一发布包切换目录、处理器、Prompt、帮助与调用方。用户须在安全点分别更新 daemon 和 Host，旧进程不热更新；历史会话、自定义 Prompt、旧收据和外部脚本不批量改写、不自动重放。
