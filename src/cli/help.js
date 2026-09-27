export const HELP = `Lush — Task 中心开发

lush [--project PATH] [--json] <command>
  daemon start|stop|restart|status     项目 daemon
  doctor [--verbose]                 检查运行代码身份
  status                             项目与任务状态
  web|web-restart|web-stop|web-status  Web 工作台

  say '目标' [--branch NAME]          创建独立 Task、分支与 worktree
  task list|tree|inspect ID          查看任务
  task spawn '目标' --parent ID [--name NAME]  在 say/child 下派 agent 子任务
  task message ID '说明'             给现有 Task 追加消息
  task transcript ID [--follow]      查看执行记录
  task history ID                    查看事件
  task integrate CHILD COMMIT        运行中的直接父 Agent 确认子提交
  task resolve-child-divergence ID   父 Agent 派解分歧子任务
  task reserve ID merge              冻结固定提交并请求合并/复查
  task resolve-divergence ID         处理 say 与父分支分歧
  task approve-merge ID COMMIT BASELINE  用户批准快进到 main/owner
  task unreserve ID                  撤销合并请求
  task resolve ID                    无代码改动时标记已解决
  task cancel|retry ID               停止或显式重试
  task cleanup ID [--keep-branch]    安全回收工作区

  branch tree|show BRANCH            查看分支
  branch bind BRANCH COMMIT          显式绑定已有本地分支
  branch archive BRANCH [--discard]  安全归档分支
  notice list|post|answer|dismiss    向用户提问与答复
  progress plan|complete             Agent 汇报进度
  agent show|models|set|reset|prompt|env|init  配置 Agent
  config show|set|reset              设置并发和调用限额

新输入只走 say；旧 Intent/Plan/Candidate、展示、介绍、托管、草稿和批量合并不再提供 API。
旧 SQLite 数据、会话与工作区保留原样，不迁移、不删除。
`;
