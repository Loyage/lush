import { discoverAgentModels } from '../../agent/models.js';
import { discoverAgentResources } from '../../agent/resources.js';
import { readAgentEnvironment, saveAgentEnvironment } from '../../agent/environment.js';
import { readNetworkConfiguration, saveNetworkConfiguration } from '../../agent/network.js';

/** Project-level Agent configuration. Running invocations keep their resolved profile; the next call re-reads it. */
export default {
  agentConfig() { return this.agentSettings.get(); },
  agentModels(agent) { return discoverAgentModels(this.config, agent); },
  agentResources() { return discoverAgentResources(this.config); },
  agentStatus() { return this.agentUsage.query(true); },
  agentUsageConfig() { return this.agentUsage.config(); },
  configureAgentUsage(value) { return this.agentUsage.configure(value); },
  agentUsageHistory(options) { return this.agentUsage.history(options); },
  agentConnectionsList() { return this.agentConnections.list(); },
  agentSelectionResources() { return this.agentSelection.resources(); },
  saveAgentConnection(connection, credential) { return this.agentConnections.save(connection, credential); },
  removeAgentConnection(id) { return this.agentConnections.remove(id); },
  configureConnectionSampling(sampling) { return this.agentConnections.configureSampling(sampling); },
  queryAgentConnections(id) { return this.agentConnections.query(id); },
  agentConnectionHistory(id, days) { return this.agentConnections.history(id, days); },
  startConnectionDeviceLogin(id) { return this.agentConnections.deviceStart(id); },
  pollConnectionDeviceLogin(id, loginId) { return this.agentConnections.devicePoll(id, loginId); },
  cancelConnectionDeviceLogin(id, loginId) { return this.agentConnections.deviceCancel(id, loginId); },
  startConnectionLogin(id) { return this.agentConnections.loginStart(id); },
  finishConnectionLogin(id, loginId, redirectUrl) { return this.agentConnections.loginFinish(id, loginId, redirectUrl); },
  agentNetwork() { return readNetworkConfiguration(this.config); },
  configureAgentNetwork(value) { return this.write('configure outbound network', () => saveNetworkConfiguration(this.config, value)); },
  agentEnvironment(target) { return readAgentEnvironment(this.config, target); },
  configureAgentEnvironment(target, values) { return saveAgentEnvironment(this.config, target, values); },
  configureAgents(value) { return this.agentSettings.save(value); },
};
