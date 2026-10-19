// Non-executable upgrade hints only. Never read files, replay history or invoke a replacement.
const rows = `system summary=>status
system diagnostics=>project diagnostics
system interrupt-all=>project pause
system resume-all=>project resume
system stop=>daemon request-stop
daemon status=>status --detail
log=>daemon log
input history=>input list / input draft list
input get=>input show / input draft show
input parents=>input targets
input emit=>input draft submit
input cancel-emission=>input draft cancel
input release-exclusive=>input draft release
input buffer update=>input draft update
input buffer remove=>input draft remove
notice page=>notice list --view history
notice sync=>notice events
notice post=>notice ask / notice notify
notice read=>notice mark-read
worker activity=>worker list --view recent
worker page=>worker list --view history
worker inspect=>worker show
worker history=>worker events
worker progress-history=>worker progress
worker delivery-graph=>worker merge graph
worker completion-page=>worker automation list
worker hooks=>worker automation show
worker completion=>worker automation completion
worker auto-merge=>worker automation enable/disable ID auto-merge --revision REV (先读取 worker automation show；权限为 worker.hook_update，不继承 worker.auto_merge 授权)
worker hook attach=>worker automation attach
worker hook enable=>worker automation enable
worker hook disable=>worker automation disable
worker hook remove=>worker automation detach
worker configure=>worker config set
worker clear-override=>worker config reset
worker interrupt=>worker pause
worker sync-parent=>worker sync start
worker resolve-sync=>worker sync resolve
worker merge=>worker merge request
worker merge-after=>worker merge request ID --after-settled/--after-merged ... --revision REV
worker merge-conditions=>worker merge show
worker merge-cancel=>worker merge cancel
worker merge-all=>branch merge-all
hooks list=>automation list
hooks register=>automation register
hooks save=>automation save
hooks remove=>automation remove
hooks upgrade=>automation upgrade
hooks install=>已退役；先 automation register，再单独 worker automation attach
hooks completion-defaults=>automation completion-defaults set
hooks auto-select=>config auto-answer set
hooks command=>automation command
hooks signal=>automation signal
hooks management create=>valet schedule create
hooks management enable=>valet schedule enable
hooks management disable=>valet schedule disable
hooks management receipt=>valet receipt show
hooks management emergency-preview=>valet emergency preview
hooks management emergency-stop=>valet emergency stop
hooks management permission-get=>config valet-permission show
hooks management permission-set=>config valet-permission set
valet query=>valet context show
valet history=>valet context history
valet auto-title=>valet self title
valet progress=>valet self progress
valet notice post=>valet self notice ask/notify
branch version-graph=>branch versions
branch integrate plan=>branch integrate preview
branch convergence list=>branch legacy-convergence list
branch convergence show=>branch legacy-convergence show
branch convergence runs=>branch legacy-convergence history
branch convergence retry=>branch legacy-convergence retry
branch convergence defaults show=>branch legacy-convergence defaults
branch convergence on=>已退役；不恢复持续归并写入
branch convergence off=>已退役；不修改历史启停
branch convergence mount=>已退役；不挂载持续归并
branch convergence remove=>已退役；不删除历史挂载
branch convergence defaults set=>已退役；不修改历史默认
config show=>config runtime show (只读取 system.settings；不转移旧 system.status 授权)
config set=>config runtime set
config patch=>config runtime set --data JSON
config reset=>config runtime reset
config migrate-preview=>config migration preview
config migrate=>config migration apply
agent show=>config agent show
agent set=>config agent set
agent configure=>config agent replace
agent reset=>config agent reset
agent network=>config network
agent prompt=>agent prompt show
agent init=>agent prompt init
agent env=>agent env show
agent models=>agent model list --backend pi|codex
agent resources=>agent model choices
agent usage resources=>agent resource list
agent usage show=>agent usage config show
agent usage set=>agent usage config set
agent sources list=>agent source list
agent sources show=>agent source show
agent sources save=>agent source save
agent sources remove=>agent source remove
agent sources refresh=>agent source refresh
agent sources models=>agent source models list
agent sources models-refresh=>agent source models refresh
agent sources login=>agent source login start/poll/cancel/finish
agent sources history=>agent source history
agent sources sampling=>agent source sampling set
agent packages=>agent package
self inspect=>self show
self history=>self events
parent inspect=>parent show
children inspect=>children show
children history=>children events
self auto-title=>self title
self notice post=>self notice ask --question-file FILE / self notice notify
skills get=>skills show`;
export const CLI_MIGRATIONS = Object.freeze(rows.split('\n').map(row => {
  const [path, replacement] = row.split('=>'); return Object.freeze({ path, replacement });
}));
export function migrationHint(args) {
  return CLI_MIGRATIONS.filter(item => item.path.split(' ').every((part, index) => args[index] === part))
    .sort((a, b) => b.path.length - a.path.length)[0];
}
export function legacyOptionHint(args, entry) {
  if (entry?.path === 'order') {
    const meanings = { '--management': 'valet submit', '--buffer': 'input draft create', '--append': 'input draft create --append-to ... → input draft submit；worker message 是直接追加，不完全等价', '--quiet': '--when-idle', '--defer': '删除；新建使用 order，保存使用 input draft create' };
    const flag = Object.keys(meanings).find(flag => args.includes(flag));
    if (flag) return `${flag} 已移除；改用 ${meanings[flag]}`;
  }
  if (entry?.path === 'worker create' && (args.includes('--source') || ['spawn','fork'].includes(args[2]))) return 'worker create 不再接收 spawn/fork；复制使用 --from ID，普通创建不带模式';
  if (entry?.path === 'worker config set' && args.includes('--profile-json')) return '--profile-json 已移除；使用 --data JSON';
  return null;
}
