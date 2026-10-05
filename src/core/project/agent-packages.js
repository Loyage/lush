/**
 * 项目级 Lush Pi 包管理（安装/移除/更新与资源读面）。
 *
 * 只读写项目私有的 `<home>/pi/`，不改用户默认 Pi；安装与启用分离，保存声明不等于任何 Worker
 * 会加载它。变更走 `this.write` 的 clear/delete 准入，`AgentPackages` 内部再有界串行，
 * shutdown 会封闭新调用并取消排队。只读 `agentPackages()` 不触发安装。
 *
 * RPC/HTTP 由其它分区接入 `agentPackages()` / `installAgentPackage(source)` /
 * `removeAgentPackage(id)` / `updateAgentPackage(id)`；这里不启动 Agent，也不返回 subprocess 诊断。
 */
export default {
  agentPackages() { return this.agentPackageManager.list(); },
  installAgentPackage(source) { return this.write('install agent package', () => this.agentPackageManager.install(source)); },
  removeAgentPackage(id) { return this.write('remove agent package', () => this.agentPackageManager.remove(id)); },
  updateAgentPackage(id) { return this.write('update agent package', () => this.agentPackageManager.update(id)); },
};
