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
hooks install=>已退役；先 automation register，再单独 worker automation attach
hooks completion-defaults=>automation completion-defaults set
hooks auto-select=>config auto-answer set
hooks command=>automation command
hooks signal=>automation signal
hooks management receipt=>valet receipt show
hooks management permission-get=>config valet-permission show
hooks management permission-set=>config valet-permission set
valet query=>valet context show
valet history=>valet context history
valet auto-title=>valet self title
valet progress=>valet self progress
valet notice post=>valet self notice ask/notify
config show=>config runtime show (只读取 system.settings；不转移旧 system.status 授权)
config set=>config runtime set
config patch=>config runtime set --data JSON
config reset=>config runtime reset
agent configure=>config agent replace --data JSON
agent models=>agent model list --backend pi|codex
agent resources=>agent model choices
agent sources list=>agent source list
agent sources show=>agent source show
agent sources remove=>agent source remove
agent sources refresh=>agent source refresh
agent sources models=>agent source models list
agent sources models-refresh=>agent source models refresh
self inspect=>self show
self history=>self events
parent inspect=>parent show
children inspect=>children show
children history=>children events
self auto-title=>self title
self notice post=>self notice ask --question-file FILE / self notice notify
skills get=>skills show`;
// Deleted CLI surfaces have no executable alias. Their RPCs/history remain untouched.
const retired = `worker graph
worker delivery-graph
worker completion-page
worker merge graph
worker automation list
worker watch
worker wait
worker create
worker config show
worker accept-preview
worker cleanup
branch history
branch versions
branch version-graph
branch graph
branch bind
branch archive
branch integrate
branch legacy-convergence
branch convergence
automation upgrade
automation command import
automation command history-remove
hooks upgrade
hooks command import
hooks command history-remove
valet submit
valet schedule
valet emergency
hooks management create
hooks management enable
hooks management disable
hooks management emergency-preview
hooks management emergency-stop
agent resource
agent package
agent packages
agent usage
agent prompt
agent init
agent env
agent show
agent set
agent reset
agent network
agent source save
agent source login
agent source history
agent source sampling
agent sources save
agent sources login
agent sources history
agent sources sampling
config agent show
config agent set
config agent reset
config network
config migration
config migrate-preview
config migrate`;
export const CLI_MIGRATIONS = Object.freeze([
  ...rows.split('\n').map(row => { const [path, replacement] = row.split('=>'); return Object.freeze({ path, replacement }); }),
  ...retired.split('\n').map(path => Object.freeze({ path, replacement: '此 CLI 已删除；没有可执行别名，底层兼容接口与历史保留' })),
]);
export function migrationHint(args) {
  return CLI_MIGRATIONS.filter(item => item.path.split(' ').every((part, index) => args[index] === part))
    .sort((a, b) => b.path.length - a.path.length)[0];
}
export function legacyOptionHint(args, entry) {
  if (entry?.path === 'order') {
    const meanings = { '--management': '此 CLI 已删除；管家创建由用户入口处理', '--buffer': 'input draft create', '--append': 'input draft create --append-to ... → input draft submit；worker message 是直接追加，不完全等价', '--quiet': '--when-idle', '--defer': '删除；新建使用 order，保存使用 input draft create' };
    const flag = Object.keys(meanings).find(flag => args.includes(flag));
    if (flag) return `${flag} 已移除；${meanings[flag]}`;
  }
  if (entry?.path === 'worker config set' && args.includes('--profile-json')) return '--profile-json 已移除；使用 --data JSON';
  return null;
}
