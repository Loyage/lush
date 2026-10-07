import { AgentPackages } from '../../agent/packages.js';
import { normalizeConfigurationScope, scopedConfiguration, configurationScope } from '../device-config.js';

/** Installed libraries are scoped independently from Worker opt-in resource paths. */
export default {
  packageManagerForScope(scope = 'project') {
    normalizeConfigurationScope(scope);
    if (scope === 'project') return this.agentPackageManager;
    if (!this.deviceAgentPackageManager) this.deviceAgentPackageManager = typeof this.agentPackageManager.forScope === 'function'
      ? this.agentPackageManager.forScope('device')
      : new AgentPackages(scopedConfiguration(this.config, 'device'), this.agentPackageOptions);
    return this.deviceAgentPackageManager;
  },
  async agentPackages(scope = 'project') {
    const value = await this.packageManagerForScope(scope).list();
    return value.configuration_scope ? value : { ...value, configuration_scope: configurationScope(this.config, scope, scope) };
  },
  installAgentPackage(source, scope = 'project') {
    return this.write('install agent package', () => this.packageManagerForScope(scope).install(source));
  },
  removeAgentPackage(id, scope = 'project') {
    return this.write('remove agent package', () => this.packageManagerForScope(scope).remove(id));
  },
  updateAgentPackage(id, scope = 'project') {
    return this.write('update agent package', () => this.packageManagerForScope(scope).update(id));
  },
};
