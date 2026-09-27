/** 项目级运行设置（并发上限）：可在运行时读写，写盘后立即对排队 AP 生效。 */
export default {
  runtimeSettings() { return this.config.runtimeSettings.get(); },
  configureRuntimeSettings(patch) { return this.config.configureRuntime(patch); },
};
