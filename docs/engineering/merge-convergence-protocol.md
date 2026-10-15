# 整合持久协议与历史两两算法

本篇说明 W287／D646 的技术不变量，并限定旧 W205 两两算法仅用于历史在途。当前行为见[实施接缝](merge-convergence-implementation.md)，公共参数只在[接口参考](../reference/rpc/convergence.md)维护。

阅读路线：[产品理念](../design/merge-convergence.md) → **持久协议（本篇）** → [异常与恢复](merge-convergence-cases.md) → [验证范围](merge-convergence-rollout.md)。

## 固定记录与身份

| 技术记录 | 固定事实 |
|---|---|
| 成员 | 原 Worker／真实直接父、source ref／commit、本轮 base commit、领取身份与编号快照 |
| 操作 | 目标、固定成员全集、baseline、generation、私有 integration 身份 |
| 自主节点／尝试 | 本次固定输入、上一目标／私有产物、调用归属与输出树 |
| 发布收据 | 精确单父 Squash、baseline／tree、全部成员映射、目标检出与 evidence 身份 |

记录属于真实父 Worker，不是新业务实体或新谱系。来源 parent_id／target_branch／ref／会话不改写，整合 Worker 不是来源的新父。SQLite 事务原子领取完整集合；同目标已有操作、来源状态或 revision 改变时拒绝，不以消息送达当作领取事实。

初始创建上下文不可变；目标刷新／显式重试保留私有产物与同一 Worker，追加新尝试，增加 generation 并清空旧候选／验证结果。固定成员不因后来的完成、输入或调度顺序扩张。新操作不按八项切批，也不按 runtime 两两树分阶段落地。

## 本轮增量与来源祖先

增量基点不能仅由当前 merge-base、树相等或 patch-id 猜测。taskSyncBase 优先核验上次精确落地的源提交、其在当前源的祖先关系、落地在目标中的存活，以及合法父同步收据；无该映射时仍核对原始基点及祖先。历史 code 上游未落地不能越过。

整合 Agent 必须审查每项 base_commit..source_commit，而非把完整源历史再次叠加到已 Squash 的目标。它自行决定顺序、分组和语义适配，保留目标与全部固定来源祖先；适配后 ancestry-only 只记录来源证据，不证明增量已正确应用。来源报告不能替代组合测试。

组合树通常不等于任一单源树。后续同步、迭代、版本图与验收必须依赖同一完整成员映射，不能退回单源树相等门。

## 目标变化与一次性发布

1. 私有整合 Worker 从固定 baseline 开始，审查全部来源，在自己的 worktree 组合与测试。
2. 目标前进时保留已付费适配，追加包含 previous_baseline／previous_output 的新尝试，旧测试失效；Agent 审查新增目标变化并重新适配、验证，不机械发布。
3. 调用真实退出、工作区干净、消息／待决已处理后才接受输出。候选必须保留 baseline 与全部 source commits 的祖先，generation／调用归属一致。
4. runtime 用相同输出树准备精确单父 Squash 及 evidence；这不是 runtime 自动测试。只在短发布门内复核目标／源 refs、候选、成员、检出与清洁度并受检写目标。
5. Git 成功后按精确收据结算全部成员与父 head，父收到合并 Hook 触发一次。Git 已落地而 DB 未结算只核验恢复，不再次 Squash。

准备／测试不长期占父执行位，普通单项与旧协议共享真实发布门。目标仍可前进，自动失效重试有界；未知发布保留门与现场，不能靠重试或取消“修好”。安全 Git 门不保证语义或业务质量，也不是 OS 沙箱。

## 历史 v3 两两算法（仅在途兼容）

旧固定 v3 请求继续由 convergence-plan／prepare 驱动，不转成 one_shot：

- 原成员上限八项、稳定相邻两两拓扑与奇数尾项保持；不因新操作移除旧 CHECK 或改写原节点。
- 叶子按固定增量基点、父 baseline 和来源生成归一化对象，内部节点在相同 baseline 上合成；冲突才可能创建该旧节点的 integration 身份。
- 固定对象、双输入祖先、旧 generation 与精确最终收据仍受原守卫；旧 Agent 模式不造命令证据，旧 command 模式仍需精确候选的隔离验证。
- 历史快捷指令未来执行跟随最新定义，开始固定实际版本；缺损引用／未知模式不得转成免验证或重放未知副作用。

这些兼容规则不适用于新操作，不恢复持续策略、形成窗口、动态扩批、子集绕行或固定平衡树产品要求。旧 v1／v2 也继续各自协议；新普通手动／自动合并始终 serial。

下一篇：[异常与恢复](merge-convergence-cases.md)；上一篇：[产品理念](../design/merge-convergence.md)。
