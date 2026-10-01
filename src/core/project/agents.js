import { discoverAgentModels } from '../../agent/models.js';
import { discoverAgentResources } from '../../agent/resources.js';
import { readAgentEnvironment, saveAgentEnvironment } from '../../agent/environment.js';

/** Project-level Agent configuration. Running invocations keep their resolved profile; the next call re-reads it. */
export default {
  agentConfig() { return this.agentSettings.get(); },
  agentModels(agent) { return discoverAgentModels(this.config, agent); },
  agentResources() { return discoverAgentResources(this.config); },
  agentStatus() { return this.agentUsage.query(true); },
  agentUsageConfig() { return this.agentUsage.config(); },
  configureAgentUsage(value) { return this.agentUsage.configure(value); },
  agentUsageHistory(options) { return this.agentUsage.history(options); },
  agentEnvironment(target) { return readAgentEnvironment(this.config, target); },
  configureAgentEnvironment(target, values) { return saveAgentEnvironment(this.config, target, values); },
  configureAgents(value) { return this.agentSettings.save(value); },
};
