export const HELP = `Lush — Worker 中心开发

lush [--project PATH] [--json] <command>
  daemon start|stop|restart|status     项目 daemon
  doctor [--verbose]                 检查运行代码身份
  status                             项目与 Worker 状态
  host|host-restart|host-stop|host-status  整机 Lush Host（Web 工作台入口）

  say '目标' [--branch NAME]          创建独立 Worker、分支与 worktree
  worker list|tree|inspect ID         查看 Worker
  worker spawn '目标' --parent ID [--name NAME]  在 say/child 下派 agent 子 Worker
  worker message ID '说明'            给现有 Worker 追加消息
  worker transcript ID [--follow]     查看执行记录
  worker history ID                  查看事件
  worker auto-merge ID on|off         设置 Worker 持久自动合并 hook；派生子 Worker 不可关闭
  worker reserve ID merge            发起一次合并意图（不改变自动合并开关）
  worker reserve-all BRANCH          一次把该分支下所有已静息、待合并 Worker 放入 merge 队列
  worker unreserve ID                撤销尚未发出的合并预约
  worker integrate CHILD COMMIT      历史 Worker 的父 Agent 确认固定子提交
  worker resolve-child-divergence ID 历史解分歧子 Worker
  worker resolve-divergence ID       历史 say 解分歧入口
  worker approve-merge ID COMMIT BASELINE  历史请求的用户批准入口
  worker accept ID                   用户验收 / 父 Agent 确认已交付 child（不归档）
  worker reopen ID                   历史已合并 Worker 恢复待验收（不调用 Agent）
  worker sync-parent ID              安全同步父提交；冲突只返回诊断
  worker resolve-sync ID             调用 Agent 解决已记录的同步冲突
  worker resolve ID                  无代码改动时标记已解决
  worker cancel|retry ID             停止或显式重试
  worker interrupt|resume ID         中断（暂停）后继续运行
  worker cleanup ID [--keep-branch]   安全回收工作区
  worker delete ID                   只读预检删除范围、资源与阻塞原因
  worker delete ID --confirm --revision REV  确认彻底删除（丢弃未交付代码）

  branch tree|show BRANCH            查看分支
  branch bind BRANCH COMMIT          显式绑定已有本地分支
  branch archive BRANCH [--discard]  安全归档分支
  notice list|post|answer|dismiss|read    用户决策与告知已读
  notice post '标题' [--worker ID] [--body '正文']  发给指定 Worker（Agent 默认当前 Worker）
  progress plan|complete             Agent 汇报进度
  agent show|models|set|reset|prompt|env|init  配置 Agent
  config show|set|reset              设置并发和调用限额（worker-call-limit 为单 Worker 调用上限）

新输入只走 say；旧 Intent/Plan/Candidate、展示、介绍、托管、草稿和批量合并不再提供 API。
旧数据不迁移；仅用户明确确认 worker delete 时清除所选 Worker 的专属历史与资源。
`;
