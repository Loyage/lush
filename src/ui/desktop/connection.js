import { initHelp } from '../web/assets/help.js';

const bridge = window.lushConnections;
const status = document.getElementById('connection-status');
const error = document.getElementById('connection-error');
let busy = false;

function paintBusy() {
  for (const button of document.querySelectorAll('button')) button.disabled = busy;
}
async function run(action, message) {
  if (busy) return;
  busy = true; error.textContent = ''; status.textContent = message; paintBusy();
  try { await action(); status.textContent = '已打开独立工作窗口。'; await refresh(); }
  catch (failure) { error.textContent = failure.message; status.textContent = ''; }
  finally { busy = false; paintBusy(); }
}
async function refresh() {
  const list = document.getElementById('recent-connections');
  const recent = await bridge.list();
  list.replaceChildren();
  if (!recent.length) { const row = document.createElement('li'); row.textContent = '暂无远程连接记录'; list.append(row); }
  for (const url of recent) {
    const row = document.createElement('li');
    const open = document.createElement('button'); open.type = 'button'; open.textContent = url;
    open.addEventListener('click', () => { document.getElementById('host-url').value = url; void run(() => bridge.openRemote(url), '正在连接远程 Host…'); });
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary'; remove.textContent = '仅移除记录';
    const host = document.createElement('span'); host.className = 'help-host';
    host.dataset.help = '只从最近连接中移除此地址，不退出登录、不关闭窗口，也不停止远端服务';
    host.append(remove);
    remove.addEventListener('click', () => { void run(() => bridge.remove(url), '正在移除记录…').then(() => { if (!error.textContent) status.textContent = '已移除连接记录。'; }); });
    row.append(open, host); list.append(row);
  }
  paintBusy();
}

document.getElementById('open-local').addEventListener('click', () => { void run(() => bridge.openLocal(), '正在启动本地 Host…'); });
document.getElementById('remote-form').addEventListener('submit', event => {
  event.preventDefault();
  void run(() => bridge.openRemote(document.getElementById('host-url').value), '正在连接远程 Host…');
});
initHelp();
void refresh().catch(failure => { error.textContent = `无法读取连接记录：${failure.message}`; });
window.addEventListener('focus', () => { if (!busy) void refresh().catch(failure => { error.textContent = failure.message; }); });
