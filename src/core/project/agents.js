import { discoverAgentModels } from '../../agent/models.js';
import { discoverAgentResources } from '../../agent/resources.js';
import { discoverSoftwareStatus } from '../../agent/status-software.js';
import { readAgentEnvironment, saveAgentEnvironment } from '../../agent/environment.js';
import { readNetworkConfiguration, saveNetworkConfiguration } from '../../agent/network.js';
import { settingsConfigurationScope } from '../device-config.js';
import { check } from '../types.js';
import { AgentSelectionService } from '../agent-selection.js';

/** Technical configuration is device-owned; histories and runtime consumers stay in this Project. */
export default {
  agentConnectionsForScope(scope) {
    scope = settingsConfigurationScope(this.config, scope);
    if (typeof this.agentConnections.forScope === 'function') return this.agentConnections.forScope(scope);
    return this.agentConnections;
  },
  agentConfig(scope) { return this.agentSettings.get(settingsConfigurationScope(this.config, scope)); },
  agentModels(agent, scope) { return discoverAgentModels(this.config, agent, settingsConfigurationScope(this.config, scope)); },
  agentResources(scope) { return discoverAgentResources(this.config, {}, settingsConfigurationScope(this.config, scope)); },
  agentStatus() { return discoverSoftwareStatus(this.config); },
  agentUsageConfig() { return this.agentUsage.config(); },
  configureAgentUsage(value) { return this.agentUsage.configure(value); },
  agentUsageHistory(options) { return this.agentUsage.history(options); },
  agentConnectionsList(scope) { return this.agentConnectionsForScope(scope).list(); },
  agentSelectionResources(scope) {
    const connections = this.agentConnectionsForScope(scope);
    return connections === this.agentConnections ? this.agentSelection.resources()
      : new AgentSelectionService({ agentConnections: connections }).resources();
  },
  saveAgentConnection(connection, credential, scope) { return this.agentConnectionsForScope(scope).save(connection, credential); },
  removeAgentConnection(id, scope) { return this.agentConnectionsForScope(scope).remove(id); },
  configureConnectionSampling(sampling, scope) { return this.agentConnectionsForScope(scope).configureSampling(sampling); },
  queryAgentConnections(id, scope) { return this.agentConnectionsForScope(scope).query(id); },
  agentConnectionModels(id, scope) { return this.agentConnectionsForScope(scope).models(id); },
  refreshAgentConnectionModels(id, scope) { return this.agentConnectionsForScope(scope).modelsRefresh(id ?? null); },
  agentConnectionHistory(id, days) { return this.agentConnections.history(id, days); },
  startConnectionDeviceLogin(id, scope) { return this.agentConnectionsForScope(scope).deviceStart(id); },
  pollConnectionDeviceLogin(id, loginId, scope) { return this.agentConnectionsForScope(scope).devicePoll(id, loginId); },
  cancelConnectionDeviceLogin(id, loginId, scope) { return this.agentConnectionsForScope(scope).deviceCancel(id, loginId); },
  startConnectionLogin(id, scope) { return this.agentConnectionsForScope(scope).loginStart(id); },
  finishConnectionLogin(id, loginId, redirectUrl, scope) { return this.agentConnectionsForScope(scope).loginFinish(id, loginId, redirectUrl); },
  agentNetwork(scope) { return readNetworkConfiguration(this.config, settingsConfigurationScope(this.config, scope)); },
  configureAgentNetwork(value, scope) {
    scope = settingsConfigurationScope(this.config, scope);
    return this.write('configure outbound network', () => saveNetworkConfiguration(this.config, value, scope));
  },
  agentEnvironment(target, scope) { return readAgentEnvironment(this.config, target, settingsConfigurationScope(this.config, scope)); },
  configureAgentEnvironment(target, values, scope) {
    scope = settingsConfigurationScope(this.config, scope); this.assertWritable('configure agent environment');
    check(!this.stopping, 'project is stopping');
    return saveAgentEnvironment(this.config, target, values, scope);
  },
  configureAgents(value, scope) {
    scope = settingsConfigurationScope(this.config, scope); this.assertWritable('configure agents');
    check(!this.stopping, 'project is stopping');
    return this.agentSettings.save(value, scope);
  },
};
