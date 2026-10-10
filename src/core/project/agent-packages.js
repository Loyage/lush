import { AgentPackages } from '../../agent/packages.js';
import { settingsConfigurationScope, scopedConfiguration, configurationScope } from '../device-config.js';

/** One device library; Worker opt-in resource paths remain task parameters. */
export default {
  packageManagerForScope(scope) {
    scope = settingsConfigurationScope(this.config, scope);
    if (typeof this.agentPackageManager.forScope === 'function') return this.agentPackageManager.forScope(scope);
    if (scope === 'project') return this.agentPackageManager;
    if (!this.deviceAgentPackageManager) this.deviceAgentPackageManager = new AgentPackages(
      scopedConfiguration(this.config, 'device'), this.agentPackageOptions);
    return this.deviceAgentPackageManager;
  },
  async agentPackages(scope) {
    scope = settingsConfigurationScope(this.config, scope);
    const value = await this.packageManagerForScope(scope).list();
    return value.configuration_scope ? value : { ...value, configuration_scope: configurationScope(this.config, scope, scope) };
  },
  installAgentPackage(source, scope) {
    return this.write('install agent package', () => this.packageManagerForScope(scope).install(source));
  },
  removeAgentPackage(id, scope) {
    return this.write('remove agent package', () => this.packageManagerForScope(scope).remove(id));
  },
  updateAgentPackage(id, scope) {
    return this.write('update agent package', () => this.packageManagerForScope(scope).update(id));
  },
};
