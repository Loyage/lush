import { discoverAgentModels } from '../../agent/models.js';
import { discoverAgentResources } from '../../agent/resources.js';
import { discoverSoftwareStatus } from '../../agent/status-software.js';
import { readAgentEnvironment, saveAgentEnvironment } from '../../agent/environment.js';
import { readNetworkConfiguration, saveNetworkConfiguration } from '../../agent/network.js';
import { normalizeConfigurationScope } from '../device-config.js';
import { check } from '../types.js';
import { AgentSelectionService } from '../agent-selection.js';

/** Runtime always resolves project inheritance; explicit device management cannot hit a local shadow. */
export default {
  agentConnectionsForScope(scope = 'project') {
    normalizeConfigurationScope(scope);
    if (typeof this.agentConnections.forScope === 'function') return this.agentConnections.forScope(scope);
    check(scope === 'project', 'device connections are unavailable');
    return this.agentConnections;
  },
  agentConfig(scope = 'project') { return this.agentSettings.get(normalizeConfigurationScope(scope)); },
  agentModels(agent, scope = 'project') { return discoverAgentModels(this.config, agent, normalizeConfigurationScope(scope)); },
  agentResources(scope = 'project') { return discoverAgentResources(this.config, {}, normalizeConfigurationScope(scope)); },
  agentStatus() { return discoverSoftwareStatus(this.config); },
  agentUsageConfig() { return this.agentUsage.config(); },
  configureAgentUsage(value) { return this.agentUsage.configure(value); },
  agentUsageHistory(options) { return this.agentUsage.history(options); },
  agentConnectionsList(scope = 'project') { return this.agentConnectionsForScope(scope).list(); },
  agentSelectionResources(scope = 'project') {
    normalizeConfigurationScope(scope);
    return scope === 'project' ? this.agentSelection.resources()
      : new AgentSelectionService({ agentConnections: this.agentConnectionsForScope(scope) }).resources();
  },
  saveAgentConnection(connection, credential, scope = 'project') { return this.agentConnectionsForScope(scope).save(connection, credential); },
  removeAgentConnection(id, scope = 'project') { return this.agentConnectionsForScope(scope).remove(id); },
  configureConnectionSampling(sampling, scope = 'project') { return this.agentConnectionsForScope(scope).configureSampling(sampling); },
  queryAgentConnections(id, scope = 'project') { return this.agentConnectionsForScope(scope).query(id); },
  agentConnectionModels(id, scope = 'project') { return this.agentConnectionsForScope(scope).models(id); },
  refreshAgentConnectionModels(id, scope = 'project') { return this.agentConnectionsForScope(scope).modelsRefresh(id ?? null); },
  agentConnectionHistory(id, days) { return this.agentConnections.history(id, days); },
  startConnectionDeviceLogin(id, scope = 'project') { return this.agentConnectionsForScope(scope).deviceStart(id); },
  pollConnectionDeviceLogin(id, loginId, scope = 'project') { return this.agentConnectionsForScope(scope).devicePoll(id, loginId); },
  cancelConnectionDeviceLogin(id, loginId, scope = 'project') { return this.agentConnectionsForScope(scope).deviceCancel(id, loginId); },
  startConnectionLogin(id, scope = 'project') { return this.agentConnectionsForScope(scope).loginStart(id); },
  finishConnectionLogin(id, loginId, redirectUrl, scope = 'project') { return this.agentConnectionsForScope(scope).loginFinish(id, loginId, redirectUrl); },
  agentNetwork(scope = 'project') { return readNetworkConfiguration(this.config, normalizeConfigurationScope(scope)); },
  configureAgentNetwork(value, scope = 'project') {
    normalizeConfigurationScope(scope);
    return this.write('configure outbound network', () => saveNetworkConfiguration(this.config, value, scope));
  },
  agentEnvironment(target, scope = 'project') { return readAgentEnvironment(this.config, target, normalizeConfigurationScope(scope)); },
  configureAgentEnvironment(target, values, scope = 'project') {
    normalizeConfigurationScope(scope); this.assertWritable('configure agent environment');
    check(!this.stopping, 'project is stopping');
    return saveAgentEnvironment(this.config, target, values, scope);
  },
  configureAgents(value, scope = 'project') {
    normalizeConfigurationScope(scope); this.assertWritable('configure agents');
    check(!this.stopping, 'project is stopping');
    return this.agentSettings.save(value, scope);
  },
};
