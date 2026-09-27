export const HELP = `Lush — AP 中心开发

lush [--project PATH] [--json] <command>
  daemon start|stop|restart|status     项目 daemon
  doctor [--verbose]                 检查运行代码身份
  status                             项目与 AP 状态
  host|host-restart|host-stop|host-status  整机 Lush Host（Web 工作台入口）

  say '目标' [--branch NAME]          创建独立 AP、分支与 worktree
  ap list|tree|inspect ID          查看 AP
  ap spawn '目标' --parent ID [--name NAME]  在 say/child 下派 agent 子 AP
  ap message ID '说明'             给现有 AP 追加消息
  ap transcript ID [--follow]      查看执行记录
  ap history ID                    查看事件
  ap integrate CHILD COMMIT        运行中的直接父 Agent 确认子提交
  ap resolve-child-divergence ID   父 Agent 派解分歧子 AP
  ap reserve ID merge              冻结固定提交并请求合并/复查
  ap resolve-divergence ID         处理 say 与父分支分歧
  ap approve-merge ID COMMIT BASELINE  用户批准快进到 main/owner
  ap unreserve ID                  撤销合并请求
  ap resolve ID                    无代码改动时标记已解决
  ap cancel|retry ID               停止或显式重试
  ap cleanup ID [--keep-branch]    安全回收工作区

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
