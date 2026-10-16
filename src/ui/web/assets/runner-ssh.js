import { el } from './dom.js';
import { runnerButton, runnerDetails } from './runner-settings-controls.js';

const validAlias = value => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
export const SSH_DISCOVERY_HELP = '仅读取 Host 当前系统用户 ~/.ssh/config 与该目录内有界安全 Include（最多 32 文件、128 KiB、4 层；仅末级通配）。只列具体别名，不显示正文或私钥；不读取系统配置，不执行 Match。SSH 试连只使用 HostName/User/Port/IdentityFile/IdentitiesOnly 安全子集，不支持跳板、代理、Match、条件 Include 或命令扩展；配置有被跳过内容时拒绝试连，不会忽略后继续连接。可继续手填登记别名。';

/** Dialog-local state: late reads/trials cannot overwrite edited input or a replacement dialog. */
export function runnerSshFields(content, alias, { client, current }) {
  let disposed = false, busy = false, revision = 0;
  const alive = () => !disposed && current();
  const label = el('label', undefined, 'runner-field'), select = el('select');
  select.dataset.runnerField = 'ssh_discovered'; select.setAttribute('aria-label', '选择已有 SSH 别名');
  const manual = el('option', '手动填写 SSH 别名'); manual.value = ''; select.append(manual);
  label.append(el('span', '选择已有 SSH 别名（可选）'), select);
  const selectHost = el('span', undefined, 'help-host'); selectHost.append(label);
  const detail = el('p', '仅读取 Host 当前用户的 SSH 别名，不联网。试连仅支持安全子集；跳板／代理等配置需另行核验。', 'hint');
  const limits = runnerDetails('SSH 配置范围与安全限制'); limits.append(el('p', SSH_DISCOVERY_HELP, 'hint'));
  const feedback = el('p', '', 'runner-feedback'); feedback.setAttribute('role', 'status');
  const actions = el('div', undefined, 'runner-actions');
  const distinction = el('p', 'SSH 成功 ≠ Runner 可用；试连不保存节点，也不检查 Runner。', 'hint');
  const test = runnerButton('测试 SSH', async () => {
    if (!alive() || busy || !validAlias(alias.value)) return;
    const request = ++revision, value = alias.value;
    busy = true; sync(); feedback.textContent = '正在测试 SSH 登录；不检查 Runner…';
    try {
      const result = await client.action('runner.ssh.test', { ssh_alias: value });
      if (!alive() || request !== revision || value !== alias.value) return;
      feedback.textContent = result.ok
        ? 'SSH 登录成功（仅安全子集，不使用系统配置）；SSH 成功 ≠ Runner 可用。未保存节点；仍需另行配置 Runner 凭据并检查 Runner。'
        : result.reason === 'config_unsupported' ? '当前 SSH 配置包含不支持、被跳过或未完整读取的内容；未发起 SSH 连接，不能验证原配置。填写已保留，可继续登记，SSH 需另行核验。'
        : result.reason === 'config_unavailable' ? 'SSH 配置不可安全读取；未发起 SSH 连接。填写已保留，请另行核验。'
        : `SSH 登录未确认${result.reason === 'timeout' ? '（超时）' : result.reason === 'output_limit' ? '（输出超限）' : ''}；请核对 SSH 信任与安全子集配置。填写已保留，不会重试或自动保存。`;
    } catch { if (alive() && request === revision && value === alias.value) feedback.textContent = 'SSH 测试失败；填写已保留，不会重试或自动保存。'; }
    finally { busy = false; if (alive()) sync(); }
  }, '仅执行一次固定 true 命令测试 SSH 登录，不调用模型、不安装、不修改主机信任、不保存节点；成功不代表 Runner 已安装或配对。');
  function sync() {
    select.disabled = busy;
    if (busy) { selectHost.dataset.help = 'SSH 配置读取或试连进行中；请等待，不会重复请求。'; selectHost.setAttribute('tabindex', '0'); }
    else { delete selectHost.dataset.help; selectHost.removeAttribute('tabindex'); }
    test.disable(busy || !validAlias(alias.value), busy ? 'SSH 配置读取或试连进行中；请等待。' : '请先选择或填写安全的单一 SSH 别名。');
  }
  const changed = () => { ++revision; feedback.textContent = ''; if (!busy) sync(); };
  const inputChanged = () => { select.value = ''; changed(); };
  alias.addEventListener('input', inputChanged);
  select.onchange = () => { if (!alive() || busy) return; if (select.value) alias.value = select.value; changed(); };
  actions.append(test.host); content.append(selectHost, detail, actions, distinction, feedback, limits);
  sync();
  return { async start() {
    if (!alive() || busy) return;
    const request = revision; busy = true; sync(); feedback.textContent = '正在读取本机 SSH 别名（不联网）…';
    try {
      const result = await client.read('/api/runner/ssh/aliases');
      if (!alive() || request !== revision) return;
      for (const value of result.aliases || []) if (validAlias(value)) { const option = el('option', value); option.value = value; select.append(option); }
      feedback.textContent = result.status === 'unavailable' ? 'SSH 配置不可安全读取；可继续手填别名。'
        : result.status === 'missing' ? '未找到当前系统用户的 SSH 配置；可继续手填别名。'
        : result.limited ? '已读取具体别名，但配置有不支持或未完整读取的内容；试连将拒绝，不会忽略后继续连接。可继续手填登记。' : '已读取具体 SSH 别名；选择不会连接远端。';
    } catch { if (alive() && request === revision) feedback.textContent = 'SSH 别名读取失败；可继续手填，不会自动重试。'; }
    finally { busy = false; if (alive()) sync(); }
  }, dispose() { disposed = true; ++revision; alias.removeEventListener('input', inputChanged); } };
}
