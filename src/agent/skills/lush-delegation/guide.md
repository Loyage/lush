# Lush 子 Worker 委派指南

只在本 invocation 的 `delegation` 能力开启、当前身份为 order/child 的 agent 时创建新 child。没有额外 planner、research 或 coordinator 身份；只派 agent 子 Worker，不使用退休角色、spec 或依赖参数。

## 拆分与创建

先查看启动 JSON 的 children 和 messages，不重复派已有工作。同一组文件、必须一起验证的内容交给同一个 child；仅真正独立的范围并行。小目标可以自行实现，不为走流程派工。

```bash
lush worker spawn '具体目标、改动范围和验收标准；专项与受影响回归范围；最终全量由哪个指令 Worker 负责。默认不跑全量，影响广泛或范围无法判断时说明原因并扩大验证。' --name short-kebab-name
```

spawn 默认以当前 Worker 为父，立即返回；name 使用简短英文短横线 slug。child 是独立 Worker、独立 worktree/分支和会话，不是等待式工具调用，也不是可越过 Lush 调度的后台 Shell。创建 child 时，在 Git 串行边界固定直接父分支的当前提交作为基线；兄弟工作区互不继承。只能修改自身 Worker 范围，不能提交到父分支。

必须写明改动范围、专项／受影响回归范围，以及最终全量负责的指令 Worker。child 再派工传递同一最终责任，不层层跑全量；汇总 child 额外做跨子成果集成验证。公共接口、Git、权限、持久化或调度影响广泛时扩大验证。遇到架构或产品歧义，通过 Notice 问用户。

## 非阻塞协调

派出后结束本轮，禁止 wait、sleep、poll 或后台进程等待；runtime 在 invocation 之间交付消息并唤醒父 Agent。再次唤醒先读 messages 和 children，核对交付与 integration 事实。普通成功消息可能攒到本轮 child 全部结算，失败或显式消息会及时交付。

需要补充工作时给原 child 发消息，不能擅自取消重建。一次独立消息一个调用，核验发送成功／被拒绝／未执行；不以串联最后退出码认定全部成功。冻结时合法消息可能持久暂存，不代表 Agent 已收到；遵守核心的消息准入与失败处理。

## 交付与检查

新 child 默认开启不可关闭的自动合并 Hook，由父 runtime 队列在安全点请求和串行落地。Agent 不改自动开关，不自行推进父/main。只有 integration=merged 才能称代码已进入父分支。无提交的干净 child 交付结果后待验收，没有合并提交。

父必须检查 child 成果、测试与交付事实，再做集成和最终全量；检查不等于提前验收。默认保留 child 的会话/worktree，便于追加需求，尽量随用户验收父 Worker 安全验收。不要为了减少待验收数量回收。失败、未交付改动和待决问题不能当作成功。

关闭本模块不取消既有 child，也不免除必要的检查、合法消息、等待释放本轮、分歧修复与交付义务；只是不再主动创建新子 Worker。实际 Git、权限、自动合并和生命周期规则以必需核心与真实接口返回为准。
